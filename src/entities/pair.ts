import { Price } from './fractions/price'
import { TokenAmount } from './fractions/tokenAmount'
import invariant from 'tiny-invariant'
import JSBI from 'jsbi'
import { pack, keccak256 } from '@ethersproject/solidity'
import { getCreate2Address } from '@ethersproject/address'

import {
  BigintIsh,
  FACTORY_ADDRESS,
  INIT_CODE_HASH,
  MINIMUM_LIQUIDITY,
  ZERO,
  ONE,
  FIVE,
  LP_FEES_NUMERATOR,
  PROTOCOL_FEE_NUMERATOR,
  FEES_DENOMINATOR,
  ChainId
} from '../constants'
import { sqrt, parseBigintIsh } from '../utils'
import { InsufficientReservesError, InsufficientInputAmountError } from '../errors'
import { Token } from './token'

let PAIR_ADDRESS_CACHE: { [token0Address: string]: { [token1Address: string]: string } } = {}

export class Pair {
  public readonly liquidityToken: Token
  private readonly tokenAmounts: [TokenAmount, TokenAmount]

  public static getAddress(tokenA: Token, tokenB: Token): string {
    const tokens = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA] // does safety checks

    if (PAIR_ADDRESS_CACHE?.[tokens[0].address]?.[tokens[1].address] === undefined) {
      PAIR_ADDRESS_CACHE = {
        ...PAIR_ADDRESS_CACHE,
        [tokens[0].address]: {
          ...PAIR_ADDRESS_CACHE?.[tokens[0].address],
          [tokens[1].address]: getCreate2Address(
            FACTORY_ADDRESS,
            keccak256(['bytes'], [pack(['address', 'address'], [tokens[0].address, tokens[1].address])]),
            INIT_CODE_HASH
          )
        }
      }
    }

    return PAIR_ADDRESS_CACHE[tokens[0].address][tokens[1].address]
  }

  public constructor(tokenAmountA: TokenAmount, tokenAmountB: TokenAmount) {
    const tokenAmounts = tokenAmountA.token.sortsBefore(tokenAmountB.token) // does safety checks
      ? [tokenAmountA, tokenAmountB]
      : [tokenAmountB, tokenAmountA]
    this.liquidityToken = new Token(
      tokenAmounts[0].token.chainId,
      Pair.getAddress(tokenAmounts[0].token, tokenAmounts[1].token),
      18,
      'MED-LP',
      'MegaDex LPs'
    )
    this.tokenAmounts = tokenAmounts as [TokenAmount, TokenAmount]
  }

  /**
   * Returns true if the token is either token0 or token1
   * @param token to check
   */
  public involvesToken(token: Token): boolean {
    return token.equals(this.token0) || token.equals(this.token1)
  }

  /**
   * Returns the current mid price of the pair in terms of token0, i.e. the ratio of reserve1 to reserve0
   */
  public get token0Price(): Price {
    return new Price(this.token0, this.token1, this.tokenAmounts[0].raw, this.tokenAmounts[1].raw)
  }

  /**
   * Returns the current mid price of the pair in terms of token1, i.e. the ratio of reserve0 to reserve1
   */
  public get token1Price(): Price {
    return new Price(this.token1, this.token0, this.tokenAmounts[1].raw, this.tokenAmounts[0].raw)
  }

  /**
   * Return the price of the given token in terms of the other token in the pair.
   * @param token token to return price of
   */
  public priceOf(token: Token): Price {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.token0Price : this.token1Price
  }

  /**
   * Returns the chain ID of the tokens in the pair.
   */
  public get chainId(): ChainId {
    return this.token0.chainId
  }

  public get token0(): Token {
    return this.tokenAmounts[0].token
  }

  public get token1(): Token {
    return this.tokenAmounts[1].token
  }

  public get reserve0(): TokenAmount {
    return this.tokenAmounts[0]
  }

  public get reserve1(): TokenAmount {
    return this.tokenAmounts[1]
  }

  public reserveOf(token: Token): TokenAmount {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.reserve0 : this.reserve1
  }

  public getOutputAmount(inputAmount: TokenAmount): [TokenAmount, Pair] {
    invariant(this.involvesToken(inputAmount.token), 'TOKEN')
    if (JSBI.equal(this.reserve0.raw, ZERO) || JSBI.equal(this.reserve1.raw, ZERO)) {
      throw new InsufficientReservesError()
    }
    const inputReserve = this.reserveOf(inputAmount.token)
    const outputReserve = this.reserveOf(inputAmount.token.equals(this.token0) ? this.token1 : this.token0)
    
    // Use LP fee rate (0.17%) for AMM pricing calculation
    const inputAmountWithFee = JSBI.multiply(inputAmount.raw, LP_FEES_NUMERATOR)
    const numerator = JSBI.multiply(inputAmountWithFee, outputReserve.raw)
    const denominator = JSBI.add(JSBI.multiply(inputReserve.raw, FEES_DENOMINATOR), inputAmountWithFee)
    const grossOutputAmount = JSBI.divide(numerator, denominator)
    
    if (JSBI.equal(grossOutputAmount, ZERO)) {
      throw new InsufficientInputAmountError()
    }
    
    // Calculate protocol fee from gross output (0.08%)
    const protocolFee = JSBI.divide(JSBI.multiply(grossOutputAmount, PROTOCOL_FEE_NUMERATOR), FEES_DENOMINATOR)
    
    // Net output amount after protocol fee deduction
    const netOutputAmount = JSBI.subtract(grossOutputAmount, protocolFee)
    
    const outputAmount = new TokenAmount(
      inputAmount.token.equals(this.token0) ? this.token1 : this.token0,
      netOutputAmount
    )
    
    // For the new pair state, use gross output amount (before protocol fee) since 
    // protocol fee is sent to feeTo address and doesn't affect reserves
    const newOutputReserve = outputReserve.subtract(new TokenAmount(outputAmount.token, grossOutputAmount))
    
    return [outputAmount, new Pair(inputReserve.add(inputAmount), newOutputReserve)]
  }

  public getInputAmount(outputAmount: TokenAmount): [TokenAmount, Pair] {
    invariant(this.involvesToken(outputAmount.token), 'TOKEN')
    
    // We need to work backwards from the desired net output to find required input
    // First, calculate the gross output needed (net output + protocol fee)
    // If net output = X, then gross output = X / (1 - 0.0008) = X / 0.9992
    const grossOutputAmount = JSBI.divide(
      JSBI.multiply(outputAmount.raw, FEES_DENOMINATOR),
      JSBI.subtract(FEES_DENOMINATOR, PROTOCOL_FEE_NUMERATOR)
    )
    
    const outputReserve = this.reserveOf(outputAmount.token)
    
    if (
      JSBI.equal(this.reserve0.raw, ZERO) ||
      JSBI.equal(this.reserve1.raw, ZERO) ||
      JSBI.greaterThanOrEqual(grossOutputAmount, outputReserve.raw)
    ) {
      throw new InsufficientReservesError()
    }

    const inputReserve = this.reserveOf(outputAmount.token.equals(this.token0) ? this.token1 : this.token0)
    
    // Calculate input amount needed for gross output using LP fee rate (0.17%)
    const numerator = JSBI.multiply(JSBI.multiply(inputReserve.raw, grossOutputAmount), FEES_DENOMINATOR)
    const denominator = JSBI.multiply(JSBI.subtract(outputReserve.raw, grossOutputAmount), LP_FEES_NUMERATOR)
    const inputAmount = new TokenAmount(
      outputAmount.token.equals(this.token0) ? this.token1 : this.token0,
      JSBI.add(JSBI.divide(numerator, denominator), ONE)
    )
    
    // For new pair state, use gross output amount since protocol fee doesn't affect reserves
    const newOutputReserve = outputReserve.subtract(new TokenAmount(outputAmount.token, grossOutputAmount))
    
    return [inputAmount, new Pair(inputReserve.add(inputAmount), newOutputReserve)]
  }

  public getLiquidityMinted(
    totalSupply: TokenAmount,
    tokenAmountA: TokenAmount,
    tokenAmountB: TokenAmount
  ): TokenAmount {
    invariant(totalSupply.token.equals(this.liquidityToken), 'LIQUIDITY')
    const tokenAmounts = tokenAmountA.token.sortsBefore(tokenAmountB.token) // does safety checks
      ? [tokenAmountA, tokenAmountB]
      : [tokenAmountB, tokenAmountA]
    invariant(tokenAmounts[0].token.equals(this.token0) && tokenAmounts[1].token.equals(this.token1), 'TOKEN')

    let liquidity: JSBI
    if (JSBI.equal(totalSupply.raw, ZERO)) {
      liquidity = JSBI.subtract(sqrt(JSBI.multiply(tokenAmounts[0].raw, tokenAmounts[1].raw)), MINIMUM_LIQUIDITY)
    } else {
      const amount0 = JSBI.divide(JSBI.multiply(tokenAmounts[0].raw, totalSupply.raw), this.reserve0.raw)
      const amount1 = JSBI.divide(JSBI.multiply(tokenAmounts[1].raw, totalSupply.raw), this.reserve1.raw)
      liquidity = JSBI.lessThanOrEqual(amount0, amount1) ? amount0 : amount1
    }
    if (!JSBI.greaterThan(liquidity, ZERO)) {
      throw new InsufficientInputAmountError()
    }
    return new TokenAmount(this.liquidityToken, liquidity)
  }

  public getLiquidityValue(
    token: Token,
    totalSupply: TokenAmount,
    liquidity: TokenAmount,
    feeOn: boolean = false,
    kLast?: BigintIsh
  ): TokenAmount {
    invariant(this.involvesToken(token), 'TOKEN')
    invariant(totalSupply.token.equals(this.liquidityToken), 'TOTAL_SUPPLY')
    invariant(liquidity.token.equals(this.liquidityToken), 'LIQUIDITY')
    invariant(JSBI.lessThanOrEqual(liquidity.raw, totalSupply.raw), 'LIQUIDITY')

    let totalSupplyAdjusted: TokenAmount
    if (!feeOn) {
      totalSupplyAdjusted = totalSupply
    } else {
      invariant(!!kLast, 'K_LAST')
      const kLastParsed = parseBigintIsh(kLast)
      if (!JSBI.equal(kLastParsed, ZERO)) {
        const rootK = sqrt(JSBI.multiply(this.reserve0.raw, this.reserve1.raw))
        const rootKLast = sqrt(kLastParsed)
        if (JSBI.greaterThan(rootK, rootKLast)) {
          const numerator = JSBI.multiply(totalSupply.raw, JSBI.subtract(rootK, rootKLast))
          const denominator = JSBI.add(JSBI.multiply(rootK, FIVE), rootKLast)
          const feeLiquidity = JSBI.divide(numerator, denominator)
          totalSupplyAdjusted = totalSupply.add(new TokenAmount(this.liquidityToken, feeLiquidity))
        } else {
          totalSupplyAdjusted = totalSupply
        }
      } else {
        totalSupplyAdjusted = totalSupply
      }
    }

    return new TokenAmount(
      token,
      JSBI.divide(JSBI.multiply(liquidity.raw, this.reserveOf(token).raw), totalSupplyAdjusted.raw)
    )
  }

  /**
   * Get the gross output amount (before protocol fee deduction) for display purposes
   * @param inputAmount the input amount
   * @returns gross output amount that would be calculated by the contract
   */
  public getGrossOutputAmount(inputAmount: TokenAmount): TokenAmount {
    invariant(this.involvesToken(inputAmount.token), 'TOKEN')
    if (JSBI.equal(this.reserve0.raw, ZERO) || JSBI.equal(this.reserve1.raw, ZERO)) {
      throw new InsufficientReservesError()
    }
    const inputReserve = this.reserveOf(inputAmount.token)
    const outputReserve = this.reserveOf(inputAmount.token.equals(this.token0) ? this.token1 : this.token0)
    
    // Use LP fee rate (0.17%) for AMM pricing calculation
    const inputAmountWithFee = JSBI.multiply(inputAmount.raw, LP_FEES_NUMERATOR)
    const numerator = JSBI.multiply(inputAmountWithFee, outputReserve.raw)
    const denominator = JSBI.add(JSBI.multiply(inputReserve.raw, FEES_DENOMINATOR), inputAmountWithFee)
    const grossOutputAmount = JSBI.divide(numerator, denominator)
    
    return new TokenAmount(
      inputAmount.token.equals(this.token0) ? this.token1 : this.token0,
      grossOutputAmount
    )
  }

  /**
   * Get the protocol fee amount that would be charged for a given output
   * @param outputAmount the gross output amount
   * @returns protocol fee amount
   */
  public getProtocolFee(outputAmount: TokenAmount): TokenAmount {
    const protocolFee = JSBI.divide(JSBI.multiply(outputAmount.raw, PROTOCOL_FEE_NUMERATOR), FEES_DENOMINATOR)
    return new TokenAmount(outputAmount.token, protocolFee)
  }
}
