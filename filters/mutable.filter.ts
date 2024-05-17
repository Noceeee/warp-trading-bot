import { Filter, FilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  private readonly errorMessage: string[] = [];
  private cachedResult: FilterResult | undefined = undefined;

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {
    if (this.checkMutable) {
      this.errorMessage.push('mutable');
    }

    if (this.checkSocials) {
      this.errorMessage.push('socials');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable = !this.checkMutable || deserialize[0].isMutable;
      const socials = this.checkSocials ? await this.getSocialTypes(deserialize[0]) : [];
      const ok = !mutable && socials.length > 0;
      const message: string[] = [];

      if (mutable) {
        message.push('metadata can be changed');
      }

      if (socials.length === 0) {
        message.push('has no socials');
      } else {
        message.push(`has socials: ${socials.join(', ')}`);
      }

      const result = { ok: ok, message: ok ? undefined : `MutableSocials -> Token ${message.join(' and ')}` };

      if (!mutable) {
        this.cachedResult = result;
      }

      return result;
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`);
    }

    return {
      ok: false,
      message: `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`,
    };
  }

  private async getSocialTypes(metadata: MetadataAccountData): Promise<string[]> {
    const response = await fetch(metadata.uri);
    const data = await response.json();
    const socialTypes: string[] = [];

    if (data?.extensions) {
      if (data.extensions.website) {
        socialTypes.push('web');
      }
      if (data.extensions.twitter) {
        socialTypes.push('twitter');
      }
      if (data.extensions.telegram) {
        socialTypes.push('telegram');
      }
    }

    return socialTypes;
  }
}
