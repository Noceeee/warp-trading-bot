import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { Semaphore } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { Context, Telegraf } from 'telegraf';
import { InlineKeyboardMarkup, Message, Update } from 'telegraf/typings/core/types/typegram';
import { SqueezeListCache } from './cache/squeeze-list.cache';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';

export interface BotConfig {
  wallet: Keypair;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  maxTokensAtTheTime: number;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  trailingStopLoss: boolean;
  skipSellingIfLostMoreThan: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  checkHolders: boolean;
  checkTokenDistribution: boolean;
  checkAbnormalDistribution: boolean;
  telegramChatId: number;
}

export class Bot {
  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  private readonly semaphore: Semaphore;
  private sellExecutionCount = 0;
  private readonly stopLoss = new Map<string, TokenAmount>();
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private readonly tg_bot: Telegraf<Context<Update>>;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
    private readonly _tg_bot: Telegraf<Context<Update>>
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;
    this.semaphore = new Semaphore(config.maxTokensAtTheTime);
    this.tg_bot = _tg_bot;

    // this.tg_bot.on("message", async (ctx) => {
      
    // });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4, lag: number = 0) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`); //  - (lag * 1000)
      await sleep(this.config.autoBuyDelay); //  - (lag * 1000)
    }

    const numberOfActionsBeingProcessed =
      this.config.maxTokensAtTheTime - this.semaphore.getValue() + this.sellExecutionCount;
    if (this.semaphore.isLocked() || numberOfActionsBeingProcessed >= this.config.maxTokensAtTheTime) {
      logger.debug(
        { mint: poolState.baseMint.toString() },
        `Skipping buy because max tokens to process at the same time is ${this.config.maxTokensAtTheTime} and currently ${numberOfActionsBeingProcessed} tokens is being processed`,
      );
      return;
    }

    await this.semaphore.acquire();

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      const startTime = Date.now();
      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {

          if ((Date.now() - startTime) > 10000) {
            logger.info(`Not buying mint ${poolState.baseMint.toString()}, max buy 10 sec timer exceeded!`);
            return;
          }

          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            this.sendTelegramMessage(`💚Confirmed buy💚\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nSignature <code>${result.signature}</code>`, poolState.baseMint.toString())

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      this.semaphore.release();
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    this.sellExecutionCount++;

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          if (i < 1) { // Only check for sell signal on first attempt, not on retries
            const shouldSell = await this.waitForSellSignal(tokenAmountIn, poolKeys);

            if (!shouldSell) {
              return;
            }
          }

          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            let profitOrLoss = 0;

            try {
              this.connection.getParsedTransaction(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
              .then((parsedConfirmedTransaction) => {
                  if (parsedConfirmedTransaction) {
                      let preTokenBalances = parsedConfirmedTransaction.meta.preTokenBalances;
                      let postTokenBalances = parsedConfirmedTransaction.meta.postTokenBalances;
          
                      // Filter for WSOL mint and your public key
                      let pre = preTokenBalances
                          .filter(x => x.mint === this.config.quoteToken.mint.toString() && x.owner === this.config.wallet.publicKey.toString())
                          .map(x => x.uiTokenAmount.uiAmount)
                          .reduce((a, b) => a + b, 0); // Sum the pre values
          
                      let post = postTokenBalances
                          .filter(x => x.mint === this.config.quoteToken.mint.toString() && x.owner ===  this.config.wallet.publicKey.toString())
                          .map(x => x.uiTokenAmount.uiAmount)
                          .reduce((a, b) => a + b, 0); // Sum the post values
          
                      profitOrLoss = (post - pre) - parseFloat(this.config.quoteAmount.toFixed());

                      this.sendTelegramMessage(`⭕Confirmed sale at <b>${(post - pre).toFixed(5)}</b>⭕\n\n${profitOrLoss < 0 ? "🔴Loss👎 " : "🟢Profit👍 "}<code>${profitOrLoss.toFixed(5)}</code>\n\nRetries <code>${i + 1}/${this.config.maxSellRetries}</code>`, rawAccount.mint.toString());
                      console.log('Profit or Loss:', profitOrLoss);
                  }
              })
              .catch((error) => {
                  console.log('Error fetching transaction details:', error);
              });

             
            } catch (error) {
              console.log("Error calculating profit", error);
            }
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      this.sellExecutionCount--;
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
        ...(direction === 'buy'
          ? [
            createAssociatedTokenAccountIdempotentInstruction(
              wallet.publicKey,
              ataOut,
              wallet.publicKey,
              tokenOut.mint,
            ),
          ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const filters = new PoolFilters(this.connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await filters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async waitForSellSignal(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return true;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);
    let stopLoss: TokenAmount;

    if (!this.stopLoss.get(poolKeys.baseMint.toString())) {
      const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
      const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
      stopLoss = this.config.quoteAmount.subtract(lossAmount);

      this.stopLoss.set(poolKeys.baseMint.toString(), stopLoss);
    } else {
      stopLoss = this.stopLoss.get(poolKeys.baseMint.toString())!;
    }

    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;
    //let telegram_status_message_id: number | undefined = undefined;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut as TokenAmount;

        if (this.config.trailingStopLoss) {
          const trailingLossFraction = amountOut.mul(this.config.stopLoss).numerator.div(new BN(100));
          const trailingLossAmount = new TokenAmount(this.config.quoteToken, trailingLossFraction, true);
          const trailingStopLoss = amountOut.subtract(trailingLossAmount);

          if (trailingStopLoss.gt(stopLoss)) {
            logger.trace(
              { mint: poolKeys.baseMint.toString() },
              `Updating trailing stop loss from ${stopLoss.toFixed()} to ${trailingStopLoss.toFixed()}`,
            );
            this.stopLoss.set(poolKeys.baseMint.toString(), trailingStopLoss);
            stopLoss = trailingStopLoss;
          }
        }

        if (this.config.skipSellingIfLostMoreThan > 0) {
          const stopSellingFraction = this.config.quoteAmount
            .mul(100 - this.config.skipSellingIfLostMoreThan)
            .numerator.div(new BN(100));

          const stopSellingAmount = new TokenAmount(this.config.quoteToken, stopSellingFraction, true);

          if (amountOut.lt(stopSellingAmount)) {
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Token dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped. Initial: ${this.config.quoteAmount.toFixed()} | Current: ${amountOut.toFixed()}`,
            );

            this.sendTelegramMessage(`🚨RUG RUG RUG🚨\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nToken dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped\nInitial: <code>${this.config.quoteAmount.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>`, poolKeys.baseMint.toString())

            this.stopLoss.delete(poolKeys.baseMint.toString());
            return false;
          }
        }

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `${timesChecked}/${timesToCheck} Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        // if (timesChecked % 10 === 0 && timesChecked !== 0) {
        //   this.sendTelegramMessage(`❕Status update❕\n\n<code>${poolKeys.baseMint.toString()}</code>\n\nTake profit: <code>${takeProfit.toFixed()}</code>\nStop loss: <code>${stopLoss.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>\n\n${timesChecked}/${timesToCheck}`, poolKeys.baseMint.toString(), telegram_status_message_id)
        //     .then(x => {
        //       if (x) {
        //         telegram_status_message_id = x.message_id;
        //       }
        //     });
        // }

        if (amountOut.lt(stopLoss)) {
          this.stopLoss.delete(poolKeys.baseMint.toString());
          // this.sendTelegramMessage(`😡STOP LOSS😡\n\n<code>${poolKeys.baseMint.toString()}</code>\n\nTake profit: <code>${takeProfit.toFixed()}</code>\nStop loss: <code>${stopLoss.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>\n\n${timesChecked}/${timesToCheck}`, poolKeys.baseMint.toString(), telegram_status_message_id)
          //   .then(x => {
          //     if (x) {
          //       telegram_status_message_id = x.message_id;
          //     }
          //   });
          break;
        }

        if (amountOut.gt(takeProfit)) {
          this.stopLoss.delete(poolKeys.baseMint.toString());
          // this.sendTelegramMessage(`😸TAKE PROFIT😸\n\n<code>${poolKeys.baseMint.toString()}</code>\n\nTake profit: <code>${takeProfit.toFixed()}</code>\nStop loss: <code>${stopLoss.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>\n\n${timesChecked}/${timesToCheck}`, poolKeys.baseMint.toString(), telegram_status_message_id)
          //   .then(x => {
          //     if (x) {
          //       telegram_status_message_id = x.message_id;
          //     }
          //   });
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return true;
  }

  private async sendTelegramMessage(message: string, mint: string, messageId?: number): Promise<Message.TextMessage | undefined> {
    try {
      let kb: InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: '🍔Dexscreener', url: `https://dexscreener.com/solana/${mint}?maker=${this.config.wallet.publicKey}` },
            { text: 'Rugcheck🔍', url: `https://rugcheck.xyz/tokens/${mint}` }
          ]
        ]
      };

      if (messageId) {
        this.tg_bot.telegram.editMessageText(this.config.telegramChatId, messageId, undefined, message, {
          parse_mode: "HTML", reply_markup: kb
        });
        return undefined;

      } else {
        return await this.tg_bot.telegram.sendMessage(this.config.telegramChatId, message, {
          parse_mode: "HTML", reply_markup: kb
        });
      }

    }
    catch (e) {
      return undefined;
    }
  }
}

