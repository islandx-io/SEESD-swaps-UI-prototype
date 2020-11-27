import { action, createModule, mutation } from "vuex-class-component";
import {
  AgnosticToken,
  BaseToken,
  ConvertReturn,
  CreatePoolModule,
  CreatePoolParams,
  EosMultiRelay,
  FeeParams,
  LiquidityModule,
  LiquidityParams,
  ModalChoice,
  ModuleParam,
  NetworkChoice,
  NewOwnerParams,
  OpposingLiquid,
  OpposingLiquidParams,
  ProposedConvertTransaction,
  ProposedFromTransaction,
  ProposedToTransaction,
  TokenBalanceParam,
  TokenBalanceReturn,
  TokenMeta,
  TokenPrice,
  TradingModule,
  ViewAmount,
  ViewRelay,
  ViewToken
} from "@/types/bancor";
import {
  buildTokenId,
  compareString,
  compareToken,
  EosAccount,
  fetchMultiRelay,
  fetchMultiRelays,
  fetchTokenStats,
  fetchTradeData,
  findOrThrow,
  getBalance,
  getTokenMeta,
  updateArray
} from "@/api/helpers";
import {
  Asset,
  asset_to_number,
  number_to_asset,
  Sym as Symbol,
  Sym
} from "eos-common";
import { multiContract } from "@/api/multiContractTx";
import { vxm } from "@/store";
import { rpc } from "@/api/rpc";
import {
  calculateFundReturn,
  composeMemo,
  DryRelay,
  findCost,
  findNewPath,
  findReturn,
  HydratedRelay,
  relaysToConvertPaths,
  TokenAmount
} from "@/api/eosBancorCalc";

import _ from "lodash";
import wait from "waait";
import { getHardCodedRelays } from "./staticRelays";
import { sortByNetworkTokens } from "@/api/sortByNetworkTokens";
import { liquidateAction, hydrateAction } from "@/api/singleContractTx";

const compareAgnosticToBalanceParam = (
  agnostic: AgnosticToken,
  balance: TokenBalanceReturn
) =>
  compareString(balance.contract, agnostic.contract) &&
  compareString(agnostic.symbol, balance.symbol);

const agnosticToTokenBalanceParam = (
  agnostic: AgnosticToken
): TokenBalanceParam => ({
  contract: agnostic.contract,
  symbol: agnostic.symbol
});

const dryToTraditionalEdge = (relay: DryRelay): [string, string] => [
  buildTokenId({
    contract: relay.reserves[0].contract,
    symbol: relay.reserves[0].symbol.code().to_string()
  }),
  buildTokenId({
    contract: relay.reserves[1].contract,
    symbol: relay.reserves[1].symbol.code().to_string()
  })
];

const pureTimesAsset = (asset: Asset, multiplier: number) => {
  const newAsset = new Asset(asset.to_string());
  return newAsset.times(multiplier);
};

const tokenContractSupportsOpen = async (contractName: string) => {
  const abiConf = await rpc.get_abi(contractName);
  return abiConf.abi.actions.some(action => action.name == "open");
};

const getSymbolName = (tokenSymbol: TokenSymbol) =>
  tokenSymbol.symbol.code().to_string();

const relayHasReserveBalances = (relay: EosMultiRelay) =>
  relay.reserves.every(reserve => reserve.amount > 0);

const reservesIncludeTokenMeta = (tokenMeta: TokenMeta[]) => (
  relay: EosMultiRelay
) => {
  const status = relay.reserves.every(reserve =>
    tokenMeta.some(
      meta =>
        compareString(reserve.contract, meta.account) &&
        compareString(reserve.symbol, meta.symbol)
    )
  );
  if (!status)
    console.warn(
      "Dropping relay",
      relay.reserves.map(x => x.symbol),
      "because it does not exist in tokenMeta"
    );
  return status;
};

const compareEosTokenSymbol = (
  a: DryRelay["smartToken"],
  b: DryRelay["smartToken"]
) => compareString(a.contract, b.contract) && a.symbol.isEqual(b.symbol);

const reservesIncludeTokenMetaDry = (tokenMeta: TokenMeta[]) => (
  relay: DryRelay
) => {
  const status = relay.reserves.every(reserve =>
    tokenMeta.some(
      meta =>
        compareString(reserve.contract, meta.account) &&
        compareString(reserve.symbol.code().to_string(), meta.symbol)
    )
  );
  if (!status)
    console.warn(
      "Dropping relay containing reserves",
      relay.reserves.map(x => x.symbol).toString(),
      "because they are not included in reserves"
    );
  return status;
};

const compareEosMultiToDry = (multi: EosMultiRelay, dry: DryRelay) =>
  compareString(
    buildTokenId({
      contract: multi.smartToken.contract,
      symbol: multi.smartToken.symbol
    }),
    buildTokenId({
      contract: dry.smartToken.contract,
      symbol: dry.smartToken.symbol.code().to_string()
    })
  );

const fetchBalanceAssets = async (tokens: BaseToken[], account: string) => {
  return Promise.all(
    tokens.map(async token => {
      const res: { rows: { balance: string }[] } = await rpc.get_table_rows({
        code: token.contract,
        scope: account,
        table: "accounts"
      });
      const assets = res.rows.map(row => new Asset(row.balance));
      const foundAsset = assets.find(
        asset => asset.symbol.code().to_string() == token.symbol
      );
      return foundAsset;
    })
  );
};

interface TokenPriceDecimal extends TokenPrice {
  decimals: number;
}

interface EosOpposingLiquid extends OpposingLiquid {
  smartTokenAmount: Asset;
}

const blackListedTokens: BaseToken[] = [
  { contract: "therealkarma", symbol: "KARMA" },
  { contract: "wizznetwork1", symbol: "WIZZ" }
];

const noBlackListedReservesDry = (blackListedTokens: BaseToken[]) => (
  relay: DryRelay
) =>
  !relay.reserves.some(reserve =>
    blackListedTokens.some(
      token =>
        compareString(reserve.contract, token.contract) &&
        compareString(reserve.symbol.code().to_string(), token.symbol)
    )
  );

const noBlackListedReserves = (blackListedTokens: BaseToken[]) => (
  relay: EosMultiRelay
): boolean =>
  !relay.reserves.some(reserve =>
    blackListedTokens.some(
      token =>
        compareString(reserve.contract, token.contract) &&
        compareString(reserve.symbol, reserve.symbol)
    )
  );

const mandatoryNetworkTokens: BaseToken[] = [
  { contract: "eosio.token", symbol: "TLOS" }
//  { contract: "tokens.swaps", symbol: "TLOSD" }
];

const isBaseToken = (token: BaseToken) => (comparasion: BaseToken): boolean =>
  token.symbol == comparasion.symbol && token.contract == comparasion.contract;

const relayIncludesBothTokens = (
  networkTokens: BaseToken[],
  tradingTokens: BaseToken[]
) => {
  const networkTokensExcluded = _.differenceWith(
    tradingTokens,
    networkTokens,
    _.isEqual
  );

  return (relay: EosMultiRelay) => {
    const includesNetworkToken = relay.reserves.some(reserve =>
      networkTokens.some(isBaseToken(reserve))
    );
    const includesTradingToken = relay.reserves.some(reserve =>
      networkTokensExcluded.some(isBaseToken(reserve))
    );
    const includesNetworkTokens = relay.reserves.every(reserve =>
      networkTokens.some(isBaseToken(reserve))
    );
    return (
      (includesNetworkToken && includesTradingToken) || includesNetworkTokens
    );
  };
};

const lowestAsset = (assetOne: Asset, assetTwo: Asset) =>
  assetOne.isLessThan(assetTwo) ? assetOne : assetTwo;

const assetToSymbolName = (asset: Asset) => asset.symbol.code().to_string();

export interface ViewTokenMinusLogo {
  symbol: string;
  name: string;
  price: number;
//  priceTlos: number;
  liqDepth: number;
  change24h: number;
  volume24h: number;
  source: string;
  precision: number;
  contract: string;
  balance?: number;
}

const agnosticToAsset = (agnostic: AgnosticToken): Asset =>
  number_to_asset(
    agnostic.amount,
    new Sym(agnostic.symbol, agnostic.precision)
  );

const agnosticToTokenAmount = (agnostic: AgnosticToken): TokenAmount => ({
  contract: agnostic.contract,
  amount: agnosticToAsset(agnostic)
});

const simpleReturn = (from: Asset, to: Asset) =>
  asset_to_number(to) / asset_to_number(from);

const baseReturn = (from: AgnosticToken, to: AgnosticToken, decAmount = 1) => {
  const fromAsset = agnosticToAsset(from);
  const toAsset = agnosticToAsset(to);
  const reward = simpleReturn(fromAsset, toAsset);
  return number_to_asset(reward, toAsset.symbol);
};

interface KnownPrice {
  symbol: string;
  unitPrice: number;
}

export interface TokenSymbol {
  contract: EosAccount;
  symbol: Symbol;
}

const compareTokenSymbol = (t1: TokenSymbol, t2: TokenSymbol) =>
  compareString(t1.contract, t2.contract) &&
  compareString(t1.symbol.code().to_string(), t2.symbol.code().to_string());

const compareEosMultiRelay = (r1: EosMultiRelay, r2: EosMultiRelay) =>
  compareString(r1.id, r2.id);

const compareAssetPrice = (asset: Asset, knownPrice: KnownPrice) =>
  compareString(assetToSymbolName(asset), knownPrice.symbol);

const sortByKnownToken = (assets: Asset[], knownPrices: KnownPrice[]) =>
  assets.sort(a =>
    knownPrices.some(price => compareAssetPrice(a, price)) ? -1 : 1
  );

const calculatePriceBothWays = (
  reserves: AgnosticToken[],
  knownPrices: KnownPrice[]
) => {
  const atLeastOnePriceKnown = reserves.some(reserve =>
    knownPrices.some(price => compareString(reserve.symbol, price.symbol))
  );
  if (reserves.length !== 2)
    throw new Error("This only works for 2 reserve relays");
  if (!atLeastOnePriceKnown)
    throw new Error(
      "Failed to determine USD price, was not passed in known prices"
    );
  if (reserves.some(reserve => reserve.amount == 0))
    throw new Error("One of more of the reserves passed has a zero balance");

  const [reserveOne, reserveTwo] = reserves;
  const rewards = [
    baseReturn(reserveOne, reserveTwo),
    baseReturn(reserveTwo, reserveOne)
  ];

  const [knownValue, unknownValue] = sortByKnownToken(rewards, knownPrices);

  const knownToken = knownPrices.find(price =>
    compareAssetPrice(knownValue, price)
  )!.unitPrice;
  const unknownToken = asset_to_number(knownValue) * knownToken;

  return [
    {
      unitPrice: knownToken,
      symbol: knownValue.symbol.code().to_string()
    },
    {
      unitPrice: unknownToken,
      symbol: unknownValue.symbol.code().to_string()
    }
  ];
};

const calculateLiquidtyDepth = (
  relay: EosMultiRelay,
  knownPrices: KnownPrice[]
) => {
  const [indexedToken] = sortByKnownToken(
    relay.reserves.map(agnosticToAsset),
    knownPrices
  );
  return (
    asset_to_number(indexedToken) *
    knownPrices.find(price => compareAssetPrice(indexedToken, price))!.unitPrice
  );
};

const buildTwoFeedsFromRelay = (
  relay: EosMultiRelay,
  knownPrices: KnownPrice[]
): RelayFeed[] => {
  const prices = calculatePriceBothWays(relay.reserves, knownPrices);
  return prices.map(price => {
    const token = relay.reserves.find(reserve =>
      compareString(reserve.symbol, price.symbol)
    )!;
    return {
      costByNetworkUsd: price.unitPrice,
//      costByNetworkTlos: price.unitPrice,
      liqDepth: calculateLiquidtyDepth(relay, knownPrices),
      smartTokenId: buildTokenId({
        contract: relay.smartToken.contract,
        symbol: relay.smartToken.symbol
      }),
      smartPriceApr: relay.apr,
      tokenId: buildTokenId({ contract: token.contract, symbol: token.symbol })
    };
  });
};

const getEosioTokenPrecision = async (
  symbol: string,
  contract: string
): Promise<number> => {
  const res = await rpc.get_table_rows({
    code: contract,
    table: "stat",
    scope: symbol
  });
  if (res.rows.length == 0) throw new Error("Failed to find token");
  return new Asset(res.rows[0].supply).symbol.precision();
};

const chopSecondSymbol = (one: string, two: string, maxLength = 7) =>
  two.slice(0, maxLength - one.length) + one;

const chopSecondLastChar = (text: string, backUp: number) => {
  const secondLastIndex = text.length - backUp - 1;
  return text
    .split("")
    .filter((_, index) => index !== secondLastIndex)
    .join("");
};

const tokenStrategies: Array<(one: string, two: string) => string> = [
  chopSecondSymbol,
  (one, two) => chopSecondSymbol(one, chopSecondLastChar(two, 1)),
  (one, two) => chopSecondSymbol(one, chopSecondLastChar(two, 2)),
  (one, two) => chopSecondSymbol(one, chopSecondLastChar(two, 3)),
  (one, two) => chopSecondSymbol(one, two.split("").reverse().join(""))
];

const generateSmartTokenSymbol = async (
  symbolOne: string,
  symbolTwo: string,
  multiTokenContract: string
) => {
  for (const strat in tokenStrategies) {
    const draftedToken = tokenStrategies[strat](symbolOne, symbolTwo);
    try {
      await getEosioTokenPrecision(draftedToken, multiTokenContract);
    } catch (e) {
      return draftedToken;
    }
  }
  throw new Error("Failed to find a new SmartTokenSymbol!");
};

const multiToDry = (relay: EosMultiRelay): DryRelay => ({
  reserves: relay.reserves.map(reserve => ({
    contract: reserve.contract,
    symbol: new Symbol(reserve.symbol, reserve.precision)
  })),
  contract: relay.contract,
  smartToken: {
    symbol: new Symbol(relay.smartToken.symbol, relay.smartToken.precision),
    contract: relay.smartToken.contract
  },
  isMultiContract: relay.isMultiContract
});

const eosMultiToHydrated = (relay: EosMultiRelay): HydratedRelay => ({
  reserves: relay.reserves.map(
    (reserve): TokenAmount => ({
      contract: reserve.contract,
      amount: number_to_asset(
        reserve.amount,
        new Symbol(reserve.symbol, reserve.precision)
      )
    })
  ),
  contract: relay.contract,
  fee: relay.fee,
  isMultiContract: relay.isMultiContract,
  smartToken: {
    symbol: new Symbol(relay.smartToken.symbol, relay.smartToken.precision),
    contract: relay.smartToken.contract
  },
  apr: relay.apr
});

type FeatureEnabled = (relay: EosMultiRelay, loggedInUser: string) => boolean;
type Feature = [string, FeatureEnabled];

const isOwner: FeatureEnabled = (relay, account) => relay.owner == account;

const multiRelayToSmartTokenId = (relay: EosMultiRelay) =>
  buildTokenId({
    contract: relay.smartToken.contract,
    symbol: relay.smartToken.symbol
  });

interface RelayFeed {
  smartTokenId: string;
  tokenId: string;
  liqDepth: number;
  costByNetworkUsd?: number;
//  costByNetworkTlos?: number;
  change24H?: number;
  volume24H?: number;
  smartPriceApr?: number;
}

const VuexModule = createModule({
  strict: false
});

export class TlosBancorModule
  extends VuexModule.With({ namespaced: "tlosBancor/" })
  implements TradingModule, LiquidityModule, CreatePoolModule {
  initialised: boolean = false;
  relaysList: EosMultiRelay[] = [];
  relayFeed: RelayFeed[] = [];
  loadingPools: boolean = true;
  usdPrice = 0;
  usdPriceOfTlos = 0;
  usdTlos24hPriceMove = 0.0;
  tokenMeta: TokenMeta[] = [];
  moreTokensAvailable = false;
  loadingTokens = false;

  get morePoolsAvailable() {
    return false;
  }

  @mutation setLoadingPools(status: boolean) {
    this.loadingPools = status;
  }

  @action async loadMorePools() {}

  get supportedFeatures() {
    return (id: string) => {
      const isAuthenticated = this.isAuthenticated;
      const relay = this.relaysList.find(relay => compareString(relay.id, id))!;
      const features: Feature[] = [
        ["addLiquidity", () => true],
        ["removeLiquidity", relay => relay.reserves.some(reserve => reserve.amount > 0)]
      ];
      return features
        .filter(([name, test]) => test(relay, isAuthenticated))
        .map(([name]) => name);
    };
  }

  get isAuthenticated() {
    // @ts-ignore
    return this.$store.rootGetters[`${this.wallet}Wallet/isAuthenticated`];
  }

  get wallet() {
    return "tlos";
  }

  get balance() {
    return (token: { contract: string; symbol: string }) => {
      // @ts-ignore
      return this.$store.rootGetters[`${this.wallet}Network/balance`](token);
    };
  }

  get newPoolTokenChoices() {
    return (networkToken: string): ModalChoice[] => {
      return this.tokenMeta
        .map(tokenMeta => {
          const { symbol, account: contract } = tokenMeta;
          const balance = this.balance({
            contract,
            symbol
          });
          return {
            id: buildTokenId({ contract, symbol }),
            symbol,
            contract,
            balance: balance && balance.balance,
            img: tokenMeta.logo
          };
        })
        .filter(
          (value, index, array) =>
            array.findIndex(token => value.symbol == token.symbol) == index
        )
        .filter(tokenMeta => {
          // currently been asked to allow new relays of the same reserve.
          return true;

          // const suggestedReserves = [tokenMeta.id, networkToken];
          // const existingReserveExists = this.relays.some(relay =>
          // relay.reserves.every(existingReserve =>
          // suggestedReserves.some(suggestedReserve =>
          // compareString(existingReserve.id, suggestedReserve)
          // )
          // )
          // );
          // return !existingReserveExists;
        })
        .filter(
          token =>
            !mandatoryNetworkTokens.some(
              networkToken => token.symbol == networkToken.symbol
            )
        )
        .sort((a, b) => {
          const second = isNaN(b.balance) ? 0 : Number(b.balance);
          const first = isNaN(a.balance) ? 0 : Number(a.balance);
          return second - first;
        });
    };
  }

  get newNetworkTokenChoices(): NetworkChoice[] {
    const tlos: BaseToken = {
      symbol: "TLOS",
      contract: "eosio.token"
    };

    const tlosd: BaseToken = {
      symbol: "TLOSD",
      contract: "tokens.swaps"
    };

    return [
      {
        ...tlos,
        id: buildTokenId(tlos),
        usdValue: this.usdPriceOfTlos
      },
      {
        ...tlosd,
        id: buildTokenId(tlosd),
        usdValue: 1
      }
    ].map(choice => ({
      ...choice,
      balance: this.balance(choice) && this.balance(choice)!.balance,
      img: this.tokenMetaObj(choice.id).logo
    }));
  }

  get currentUserBalances(): TokenBalanceReturn[] {
    return vxm.tlosNetwork.balances;
  }

  @action async fetchTokenBalancesIfPossible(tokens: TokenBalanceParam[]) {
    if (!this.isAuthenticated) return;
    const tokensFetched = this.currentUserBalances;
    const allTokens = _.uniqBy(
      this.relaysList.flatMap(relay => relay.reserves),
      "id"
    );
    const tokenBalancesNotYetFetched = _.differenceWith(
      allTokens,
      tokensFetched,
      compareAgnosticToBalanceParam
    );

    const tokensToAskFor = _.uniqWith(
      [
        ...tokens,
        ...tokenBalancesNotYetFetched.map(agnosticToTokenBalanceParam)
      ],
      compareToken
    );

    return vxm.tlosNetwork.getBalances({ tokens: tokensToAskFor, slow: false });
  }

  @action async updateFee({ fee, id }: FeeParams) {
    const relay = await this.relayById(id);
    const updateFeeAction = multiContract.updateFeeAction(
      relay.smartToken.symbol,
      fee
    );
    const txRes = await this.triggerTx([updateFeeAction]);
    return txRes.transaction_id as string;
  }

  @action async removeRelay(id: string) {
    const relay = await this.relayById(id);
    const reserves = relay.reserves.map(reserve => reserve.symbol);
    const nukeRelayActions = multiContract.nukeRelayAction(
      relay.smartToken.symbol,
      reserves
    );
    const txRes = await this.triggerTx(nukeRelayActions);
    this.waitAndUpdate();
    return txRes.transaction_id as string;
  }

  @action async updateOwner({ id, newOwner }: NewOwnerParams) {
    const relay = await this.relayById(id);
    const updateOwnerAction = multiContract.updateOwnerAction(
      relay.smartToken.symbol,
      newOwner
    );
    const txRes = await this.triggerTx([updateOwnerAction]);
    return txRes.transaction_id as string;
  }

  @action async createPool(poolParams: CreatePoolParams): Promise<string> {
    const reserveAssets = await Promise.all(
      poolParams.reserves.map(async reserve => {
        const data = this.tokenMetaObj(reserve.id);
        return {
          amount: number_to_asset(
            Number(reserve.amount),
            new Symbol(
              data.symbol,
              await getEosioTokenPrecision(data.symbol, data.account)
            )
          ),
          contract: data.account
        };
      })
    );

    const [networkAsset, tokenAsset] = sortByNetworkTokens(
      reserveAssets.map(reserveAsset => reserveAsset.amount),
      asset => asset.symbol.code().to_string()
    );

    const smartTokenSymbol = await generateSmartTokenSymbol(
      tokenAsset.symbol.code().to_string(),
      networkAsset.symbol.code().to_string(),
      process.env.VUE_APP_SMARTTOKENCONTRACT!
    );

    const networkSymbol = networkAsset.symbol.code().to_string();
    const initialLiquidity = compareString(networkSymbol, "TLOSD")
      ? 0.5
      : 1 * asset_to_number(networkAsset);

    const actions = await multiContract.kickStartRelay(
      smartTokenSymbol,
      reserveAssets,
      Number(initialLiquidity.toFixed(0)),
      poolParams.fee
    );

    const res = await this.triggerTx(actions!);
    return res.transaction_id;
  }

  get tokenMetaObj() {
    return (id: string) => {
      return findOrThrow(
        this.tokenMeta,
        meta => compareString(meta.id, id),
        `Failed to find token meta for ${id}`
      );
    };
  }

  get relaysWithFeeds() {
    return this.relaysList
      .filter(
        relayIncludesBothTokens(
          mandatoryNetworkTokens,
          this.tokenMeta.map(token => ({
            contract: token.account,
            symbol: token.symbol
          }))
        )
      )
      .filter(relay =>
        relay.reserves.every(reserve => {
          const relayId = buildTokenId({
            contract: relay.smartToken.contract,
            symbol: relay.smartToken.symbol
          });
          const reserveId = buildTokenId({
            contract: reserve.contract,
            symbol: reserve.symbol
          });
          const feed = this.relayFeed.find(
            feed =>
              compareString(feed.smartTokenId, relayId) &&
              compareString(feed.tokenId, reserveId)
          );
          return feed;
        })
      );
  }

  get tokens(): ViewToken[] {
    return this.relaysWithFeeds
      .flatMap(relay =>
        relay.reserves.map(reserve => {
          const reserveTokenId = buildTokenId({
            contract: reserve.contract,
            symbol: reserve.symbol
          });

          const feed = findOrThrow(
            this.relayFeed,
            (feed: RelayFeed) =>
              compareString(feed.smartTokenId, relay.id) &&
              compareString(feed.tokenId, reserveTokenId),
            `failed finding relay feed for ${relay.id} ${reserveTokenId}`
          );
          return {
            id: reserveTokenId,
            symbol: reserve.symbol,
            price: feed.costByNetworkUsd,
//            priceTlos: feed.costByNetworkTlos,
            change24h: feed.change24H,
            liqDepth: feed.liqDepth,
            volume24h: feed.volume24H,
            contract: reserve.contract,
            precision: reserve.precision
          };
        })
      )
      .sort((a, b) => b.liqDepth - a.liqDepth)
      .reduce<any[]>((acc, item) => {
        const existingToken = acc.find(token =>
          compareString(token.id, item.id)
        );

        return existingToken
          ? updateArray(
              acc,
              token => compareString(token.id, item.id),
              token => ({
                ...token,
                liqDepth: existingToken.liqDepth + item.liqDepth,
                ...(!existingToken.change24h &&
                  item.change24h && { change24h: item.change24h }),
                ...(!existingToken.volume24h &&
                  item.volume24h && { volume24h: item.volume24h })
              })
            )
          : [...acc, item];
      }, [])
      .map(token => {
        const id = token.id as string;
        const contract = token.contract as string;
        const symbol = token.symbol as string;

        const tokenMeta = findOrThrow(this.tokenMeta, token =>
          compareString(token.id, id)
        );
        const tokenBalance = vxm.tlosNetwork.balance({
          contract,
          symbol
        });
        return {
          ...token,
          name: tokenMeta.name,
          balance: tokenBalance && Number(tokenBalance.balance),
          logo: tokenMeta.logo
        };
      });
  }

  get token(): (arg0: string) => ViewToken {
    return (id: string) => {
      const tradableToken = this.tokens.find(token =>
        compareString(token.id, id)
      );

      if (tradableToken) {
        return tradableToken;
      } else {
        const token = findOrThrow(
          this.relaysList.flatMap(relay => relay.reserves),
          token => compareString(token.id, id),
          `Failed to find token ${id} in this.token on Telos`
        );

        const meta = this.tokenMetaObj(token.id);

        return {
          ...token,
          name: meta.name,
          logo: meta.logo
        };
      }
    };
  }

  get relay() {
    return (id: string) => {
      return findOrThrow(
        this.relays,
        relay => compareString(relay.id, id),
        `Failed to find relay with ID of ${id}`
      );
    };
  }

  get relays(): ViewRelay[] {
    // @ts-ignore
    return this.relaysList
      .filter(
        relayIncludesBothTokens(
          mandatoryNetworkTokens,
          this.tokenMeta.map(token => ({
            contract: token.account,
            symbol: token.symbol
          }))
        )
      )
      .filter(reservesIncludeTokenMeta(this.tokenMeta))
      .map(relay => {
        const relayFeed = this.relayFeed.find(feed =>
          compareString(
            feed.smartTokenId,
            buildTokenId({
              contract: relay.smartToken.contract,
              symbol: relay.smartToken.symbol
            })
          )
        );

        const sortedReserves = sortByNetworkTokens(
          relay.reserves,
          reserve => reserve.symbol
        );

        return {
          ...relay,
          id: buildTokenId({
            contract: relay.smartToken.contract,
            symbol: relay.smartToken.symbol
          }),
          symbol: sortedReserves[1].symbol,
          smartTokenSymbol: relay.smartToken.symbol,
          apr: relayFeed && relayFeed.smartPriceApr,
          liqDepth: relayFeed && relayFeed.liqDepth,
          //          addLiquiditySupported: relay.isMultiContract,
          addLiquiditySupported: true,
          removeLiquiditySupported: true,
          focusAvailable: false,
          reserves: sortedReserves.map((reserve: AgnosticToken) => ({
            ...reserve,
            reserveId: relay.smartToken.symbol + reserve.symbol,
            logo: [this.token(reserve.id).logo],
            ...(reserve.amount && { balance: reserve.amount })
          }))
        };
      });
  }

  get convertableRelays() {
    return this.relaysWithFeeds
      .map(relay => {
        const relayId = buildTokenId({
          contract: relay.smartToken.contract,
          symbol: relay.smartToken.symbol
        });
        const feed = this.relayFeed.find(feed =>
          compareString(feed.smartTokenId, relayId)
        )!;
        return {
          ...relay,
          liqDepth: feed!.liqDepth
        };
      })
      .sort((a, b) => b.liqDepth - a.liqDepth)
      .filter(
        (value, index, arr) =>
          arr.findIndex(x =>
            x.reserves.every(reserve =>
              value.reserves.some(
                y =>
                  reserve.symbol == y.symbol && reserve.contract == y.contract
              )
            )
          ) == index
      );
  }

  @action async buildManuallyIfNotIncludedInExistingFeeds({
    relays,
    existingFeeds
  }: {
    relays: EosMultiRelay[];
    existingFeeds: RelayFeed[];
  }) {
    this.updateMultiRelays(relays);
    const relaysNotFulfilled = _.differenceWith(relays, existingFeeds, (a, b) =>
      compareString(
        buildTokenId({
          contract: a.smartToken.contract,
          symbol: a.smartToken.symbol
        }),
        b.smartTokenId
      )
    );

    await this.buildPossibleRelayFeedsFromHydrated(
      relaysNotFulfilled.filter(relayHasReserveBalances)
    );
  }

  @action async addDryPools({
    dryRelays,
    chunkSize,
    waitTime
  }: {
    dryRelays: DryRelay[];
    chunkSize: number;
    waitTime: number;
  }) {
    const chunked = _.chunk(dryRelays, chunkSize);
    const [firstChunk, ...remainingChunks] = chunked;
    const [bancorApiFeeds, firstBatch] = await Promise.all([
      this.buildPossibleRelayFeedsFromBancorApi({ relays: dryRelays }),
      this.hydrateOldRelays(firstChunk)
    ]);

    this.buildManuallyIfNotIncludedInExistingFeeds({
      relays: firstBatch,
      existingFeeds: bancorApiFeeds
    });

    for (const chunk in remainingChunks) {
      await wait(waitTime);
      let relays = await this.hydrateOldRelays(remainingChunks[chunk]);
      this.buildManuallyIfNotIncludedInExistingFeeds({
        relays,
        existingFeeds: bancorApiFeeds
      });
    }
  }

  @action async addPools({
    multiRelays,
    dryDelays,
    tokenMeta
  }: {
    multiRelays: EosMultiRelay[];
    dryDelays: DryRelay[];
    tokenMeta: TokenMeta[];
  }) {
    const passedMultiRelays = multiRelays
      .filter(reservesIncludeTokenMeta(tokenMeta))
      .filter(noBlackListedReserves(blackListedTokens));

    this.updateMultiRelays(passedMultiRelays);
    await this.buildPossibleRelayFeedsFromHydrated(
      passedMultiRelays.filter(relayHasReserveBalances)
    );

    const passedDryPools = dryDelays
      .filter(noBlackListedReservesDry(blackListedTokens))
      .filter(reservesIncludeTokenMetaDry(tokenMeta));

    await this.addDryPools({
      dryRelays: passedDryPools,
      chunkSize: 4,
      waitTime: 250
    });
  }

  @mutation setInitialised(status: boolean) {
    this.initialised = status;
  }

  @action async refresh() {
    console.log("refresh called, doing some stuff");

    const v1Relays = getHardCodedRelays();
    //    const allDry = [...v1Relays].filter(
    //        noBlackListedReservesDry(blackListedTokens)
    //    );

    this.fetchTokenBalancesIfPossible(
      _.uniqWith(
        v1Relays.flatMap(x =>
          x.reserves.map(x => ({ ...x, symbol: x.symbol.code().to_string() }))
        ),
        compareToken
      )
    );

    return;
  }

  @action async fetchBalancesFromReserves(relays: DryRelay[]) {
    const tokens = relays
      .flatMap(relay => relay.reserves)
      .map(reserve => ({
        contract: reserve.contract,
        symbol: reserve.symbol.code().to_string()
      }));

    const uniqueTokens = _.uniqWith(
      tokens,
      (a, b) =>
        compareString(a.symbol, b.symbol) &&
        compareString(a.contract, b.contract)
    );

    return vxm.tlosNetwork.getBalances({
      tokens: uniqueTokens,
      slow: false
    });
  }

  @action async bareMinimumForTrade({
    fromId,
    toId,
    v1Relays,
    v2Relays,
    tokenMeta
  }: {
    fromId: string;
    toId: string;
    v1Relays: DryRelay[];
    v2Relays: EosMultiRelay[];
    tokenMeta: TokenMeta[];
  }) {
    const allDry = [...v1Relays, ...v2Relays.map(multiToDry)];
    const foundPath = await findNewPath(fromId, toId, allDry, dry => {
      const [from, to] = dry.reserves.map(r =>
        buildTokenId({
          contract: r.contract,
          symbol: r.symbol.code().to_string()
        })
      );
      return [from, to];
    });

    const relaysInvolved = foundPath.hops.flat(1);
    const requiredV1s = relaysInvolved.filter(relay => !relay.isMultiContract);
    const accomodatingV1Relays = requiredV1s;
    await this.addPools({
      multiRelays: v2Relays,
      dryDelays: accomodatingV1Relays,
      tokenMeta
    });

    const remainingV1Relays = v1Relays.filter(
      relay =>
        !accomodatingV1Relays.some(r =>
          compareTokenSymbol(relay.smartToken, r.smartToken)
        )
    );

    this.addPools({
      multiRelays: [],
      tokenMeta,
      dryDelays: remainingV1Relays
    });
  }

  @action async loadMoreTokens(tokenIds?: string[]) {}

  get convertibleTokens() {
    return this.tokens.map(token => ({ ...token, img: token.logo }));
  }

  @action async init(param?: ModuleParam) {
    console.count("eosInit");
    console.time("eos");
    console.log("eosInit received", param);

    if (this.initialised) {
      console.log("eos refreshing instead");
      return this.refresh();
    }
    try {
      const [usdPriceOfTlos, v2Relays, tokenMeta] = await Promise.all([
        vxm.bancor.fetchUsdPriceOfTlos(),
        fetchMultiRelays(),
        getTokenMeta()
      ]);
      this.setTokenMeta(tokenMeta);
      this.setTlosPrice(usdPriceOfTlos);
//      this.setTlos24hPriceMove(-4.44);
      this.setTlos24hPriceMove(0.00);

//      console.log("tokenMeta : ", tokenMeta);
//      console.log("usdPriceOfTlos : ", usdPriceOfTlos);
//      console.log("usdTlos24hPriceMove : ", this.usdTlos24hPriceMove);

      const v1Relays = getHardCodedRelays();
//      console.log("init.v1Relays",v1Relays);
      const allDry = [...v1Relays, ...v2Relays.map(multiToDry)].filter(
        noBlackListedReservesDry(blackListedTokens)
      );

      this.fetchTokenBalancesIfPossible(
        _.uniqWith(
          allDry.flatMap(x =>
            x.reserves.map(x => ({ ...x, symbol: x.symbol.code().to_string() }))
          ),
          compareToken
        )
      );

      const quickTrade =
        param &&
        param.tradeQuery &&
        param.tradeQuery.base &&
        param.tradeQuery.quote;

//      console.log("quickTrade : ", quickTrade);
      if (quickTrade) {
        const { base: fromId, quote: toId } = param!.tradeQuery!;
        await this.bareMinimumForTrade({
          fromId,
          toId,
          v1Relays,
          v2Relays,
          tokenMeta
        });
      } else {
        await this.addPools({
          multiRelays: v2Relays,
          dryDelays: v1Relays,
          tokenMeta
        });
      }

      this.setInitialised(true);
      this.setLoadingPools(false);
      console.timeEnd("eos");
    } catch (e) {
      throw new Error(`Threw inside eosBancor: ${e.message}`);
    }
  }

  @mutation updateRelayFeed(feeds: RelayFeed[]) {
    this.relayFeed = _.uniqWith(
      [...feeds, ...this.relayFeed],
      (a, b) =>
        compareString(a.smartTokenId, b.smartTokenId) &&
        compareString(a.tokenId, b.tokenId)
    );
  }

  @action async buildPossibleRelayFeedsFromHydrated(relays: EosMultiRelay[]) {
    const feeds = relays.flatMap(relay =>
      buildTwoFeedsFromRelay(relay, [
        { symbol: "TLOSD", unitPrice: 1 },
        { symbol: "TLOS", unitPrice: this.usdPriceOfTlos }
      ])
    );
    this.updateRelayFeed(feeds);
  }

  /*
change24h: -2.287651124147028
code: "BNT"
id: "594bb7e468a95e00203b048d"
liquidityDepth: 27934.009807858576
name: "Bancor"
price: 1.0736276822045399
priceHistory: (168) [Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), Array(2), …]
primaryCommunityImageName: "https://storage.googleapis.com/bancor-prod-file-store/images/communities/f80f2a40-eaf5-11e7-9b5e-179c6e04aa7c.png"
volume24h: {ETH: 5082.435071735717, USD: 1754218.484042, EUR: 1484719.61129}
 * /

  const tokenDb_: TokenInfo[] = [
    {
      change24h: -2.287651124147028,
      code: "BNT",
      id: "594bb7e468a95e00203b048d",
      liquidityDepth: 27934.009807858576,
      name: "Bancor",
      price: 1.0736276822045399,
      primaryCommunityImageName: "https://storage.googleapis.com/bancor-prod-file-store/images/communities/f80f2a40-eaf5-11e7-9b5e-179c6e04aa7c.png",
      volume24h: {ETH: 5082.435071735717, USD: 1754218.484042, EUR: 1484719.61129}
    },
    {
      change24h: -2.287651124147028,
      code: "BNT",
      id: "594bb7e468a95e00203b048d",
      liquidityDepth: 27934.009807858576,
      name: "Bancor",
      price: 1.0736276822045399,
      primaryCommunityImageName: "https://storage.googleapis.com/bancor-prod-file-store/images/communities/f80f2a40-eaf5-11e7-9b5e-179c6e04aa7c.png",
      volume24h: {ETH: 5082.435071735717, USD: 1754218.484042, EUR: 1484719.61129}
    }];
*/

  @action async buildPossibleRelayFeedsFromBancorApi({
    relays
  }: {
    relays: DryRelay[];
  }) {
    try {
      // https://api.bancor.network/0.1/currencies/tokens?blockchainType=eos&fromCurrencyCode=USD&includeTotal=true&limit=150&orderBy=volume24h&skip=0&sortOrder=desc
      //      const tokenData: TokenPrice[] = (<any>data).data.page;
      //      const [tokenPrices] = await Promise.all([tokenData]);

      // Pull token prices from chain
      const [tokenPrices] = await Promise.all([fetchTradeData()]);

      const tlosToken = findOrThrow(tokenPrices, token =>
        compareString(token.code, "TLOS")
      );

      const relayFeeds: RelayFeed[] = relays.flatMap(relay => {
        const [
          secondaryReserve,
          primaryReserve
        ] = sortByNetworkTokens(relay.reserves, reserve =>
          reserve.symbol.code().to_string()
        );

        const token = findOrThrow(
          tokenPrices,
          price =>
            compareString(price.code, primaryReserve.symbol.code().to_string()),
          "failed to find token in possible relayfeeds from bancor API"
        );

        const includeTLOS = compareString(
          secondaryReserve.symbol.code().to_string(),
          "TLOS"
        );

        // const liqDepth = token.liquidityDepth * usdPriceOfEth * 2;
        // should use USD price of TLOS
        const liqDepth = token.liquidityDepth;

        const secondary = {
          tokenId: buildTokenId({
            contract: secondaryReserve.contract,
            symbol: secondaryReserve.symbol.code().to_string()
          }),
          smartTokenId: buildTokenId({
            contract: relay.smartToken.contract,
            symbol: relay.smartToken.symbol.code().to_string()
          })
        };

        return [
          {
            change24H: token.change24h,
            costByNetworkUsd: token.price,
//            costByNetworkTlos: token.priceTlos,
//            liqDepth: token.liquidityDepth,
            liqDepth,
            tokenId: buildTokenId({
              contract: primaryReserve.contract,
              symbol: primaryReserve.symbol.code().to_string()
            }),
            smartTokenId: buildTokenId({
              contract: relay.smartToken.contract,
              symbol: relay.smartToken.symbol.code().to_string()
            }),
            volume24H: token.volume24h.USD,
            smartPriceApr: token.smartPriceApr
          },
          includeTLOS
            ? {
                ...secondary,
//                liqDepth: tlosToken.liquidityDepth,
                liqDepth,
                costByNetworkUsd: tlosToken.price,
                change24H: tlosToken.change24h,
                volume24H: tlosToken.volume24h.USD,
                smartPriceApr: tlosToken.smartPriceApr
              }
            : {
                ...secondary,
                liqDepth
//                liqDepth: tlosToken.liquidityDepth
              }
        ];
      });
      this.updateRelayFeed(relayFeeds);
      return relayFeeds;
    } catch (e) {
      console.error(e);
      return [];
    }
  }

  @action async hydrateOldRelays(relays: DryRelay[]) {
    return Promise.all(
      relays.map(
        async (relay): Promise<EosMultiRelay> => {
          const [settings, reserveBalances] = await Promise.all([
            rpc.get_table_rows({
              code: relay.contract,
              scope: relay.contract,
              table: "settings"
            }) as Promise<{
              rows: {
                smart_contract: string;
                smart_currency: string;
                smart_enabled: boolean;
                enabled: boolean;
                network: string;
                max_fee: number;
                fee: number;
              }[];
            }>,
            fetchBalanceAssets(
              relay.reserves.map(reserve => ({
                contract: reserve.contract,
                symbol: reserve.symbol.code().to_string()
              })),
              relay.contract
            ) as Promise<Asset[]>
          ]);

          const allBalancesFetched = reserveBalances.every(Boolean);
          if (!allBalancesFetched)
            throw new Error(
              `Failed to find both reserve balances on old pool ${relay.contract}`
            );

          const mergedBalances = relay.reserves.map(reserve => ({
            ...reserve,
            amount: reserveBalances.find(balance =>
              balance.symbol.isEqual(reserve.symbol)
            )!
          }));

          const smartTokenSymbol = relay.smartToken.symbol.code().to_string();

          const smartTokenId = buildTokenId({
            contract: relay.smartToken.contract,
            symbol: smartTokenSymbol
          });

          const feed = this.relayFeed.find(feed =>
            compareString(feed.smartTokenId, smartTokenId)
          );
          const apr: number = (feed && feed.smartPriceApr) ? feed.smartPriceApr : 0.0;

          return {
            id: smartTokenId,
            contract: relay.contract,
            isMultiContract: false,
            fee: settings.rows[0].fee / 1000000,
            owner: relay.contract,
            smartEnabled: settings.rows[0].smart_enabled,
            smartToken: {
              id: smartTokenId,
              amount: 0,
              contract: relay.smartToken.contract,
              precision: 4,
              network: "tlos",
              symbol: smartTokenSymbol
            },
            reserves: mergedBalances.map(reserve => ({
              ...reserve,
              id: buildTokenId({
                contract: reserve.contract,
                symbol: assetToSymbolName(reserve.amount)
              }),
              network: "tlos",
              precision: reserve.amount.symbol.precision(),
              contract: reserve.contract,
              symbol: assetToSymbolName(reserve.amount),
              amount: asset_to_number(reserve.amount)
            })),
            apr: apr
          };
        }
      )
    );
  }

  @action async refreshBalances(tokens: BaseToken[] = []) {
    if (!this.isAuthenticated) return;
    if (tokens.length > 0) {
      await vxm.tlosNetwork.getBalances({ tokens });
      return;
    }
    await vxm.tlosNetwork.getBalances();
  }

  @action async addLiquidity({
    id: relayId,
    reserves,
    onUpdate
  }: LiquidityParams) {
    const relay = await this.relayById(relayId);
    const tokenAmounts = await this.viewAmountToTokenAmounts(reserves);
    /*
        console.log("addLiquidity - relayId : ", relayId);
        console.log("addLiquidity - reserves : ", reserves);
        console.log("addLiquidity - relay : ", relay);
        console.log("addLiquidity - tokenAmounts : ", tokenAmounts);

        console.log("addLiquidity - tokenAmounts[0].contract : ",tokenAmounts[0].contract);
        console.log("addLiquidity - tokenAmounts[0].symbol : ",tokenAmounts[0].amount.symbol.code().to_string());
        console.log("addLiquidity - tokenAmounts[0].amount : ",tokenAmounts[0].amount.to_string());

        console.log("addLiquidity - tokenAmounts[1].contract : ",tokenAmounts[1].contract);
        console.log("addLiquidity - tokenAmounts[1].symbol : ",tokenAmounts[1].amount.symbol.code().to_string());
        console.log("addLiquidity - tokenAmounts[1].amount : ",tokenAmounts[1].amount.to_string());

        console.log("addLiquidity - relay.smartToken.symbol : ", relay.smartToken.symbol);
        console.log("addLiquidity - relay.smartToken.precision : ", relay.smartToken.precision);
    */
    // TODO figure out why smart token precision is wrong
    const relayContract = relay.smartToken.contract;
    const relaySymbol = new Symbol(
      relay.smartToken.symbol,
      relay.smartToken.precision
    );
    const relaySymbolCode = relaySymbol.code().to_string();

    if (tokenAmounts.length !== 2)
      throw new Error("Was expecting 2 reserve assets");

    // TODO handle tokenAmounts as array
    const action1 = hydrateAction(
      tokenAmounts[0].amount,
      tokenAmounts[0].contract,
      number_to_asset(0, relaySymbol),
      relay.contract,
      this.isAuthenticated
    );
    const action2 = hydrateAction(
      tokenAmounts[1].amount,
      tokenAmounts[1].contract,
      number_to_asset(0, relaySymbol),
      relay.contract,
      this.isAuthenticated
    );
    let depositActions = [action1, action2];

    /*
    // TODO fix this, relay token precision is wrong
    const existingBalance = await this.hasExistingBalance({
      contract: relayContract,
      symbol: relaySymbolCode
    });

    if (!existingBalance) {
      const openActions = await this.generateOpenActions({
        contract: relayContract,
        symbol: relaySymbol
      });
      depositActions = [...openActions, ...depositActions];
    }
     */

//    console.log("convertActions : ", depositActions);

    //    if (depositActions.length > 0) {
    //      await this.triggerTx(depositActions);
    //    }

    const txRes = await this.triggerTx(depositActions);
//    console.log("txRes : ", txRes);

    return txRes.transaction_id as string;
  }

  /*
      @action async addLiquidity({
        id: relayId,
        reserves,
        onUpdate
      }: LiquidityParams) {
        const relay = await this.relayById(relayId);
        const tokenAmounts = await this.viewAmountToTokenAmounts(reserves);

        console.log("addLiquidity(", relay, ")");
        const tokenContractsAndSymbols: BaseToken[] = [
          {
            contract: relay.smartToken.contract,
            symbol: relay.smartToken.symbol
          },
          ...tokenAmounts.map(tokenAmount => ({
            contract: tokenAmount.contract,
            symbol: tokenAmount.amount.symbol.code().to_string()
          }))
        ];

        const originalBalances = await vxm.tlosNetwork.getBalances({
          tokens: tokenContractsAndSymbols
        });

        const finalState = await multiSteps({
          items: [
            {
              description: "Depositing liquidity...",
              task: async () => {
                const addLiquidityActions = multiContract.addLiquidityActions(
                  relay.smartToken.symbol,
                  tokenAmounts
                );

                const { smartTokenAmount } = await this.calculateOpposingDeposit({
                  id: relayId,
                  reserve: reserves[0]
                });

                const fundAmount = smartTokenAmount;

                const fundAction = multiContractAction.fund(
                  this.isAuthenticated,
                  smartTokenAmount.to_string()
                );

                const actions = [...addLiquidityActions, fundAction];

                try {
                  const txRes = await this.triggerTx(actions);
                  return {
                    failedDueToBadCalculation: false,
                    txRes
                  };
                } catch (e) {
                  if (
                    e.message !==
                    "assertion failure with message: insufficient balance"
                  )
                    throw new Error(e);
                  return {
                    failedDueToBadCalculation: true,
                    addLiquidityActions,
                    fundAmount
                  };
                }
              }
            },
            {
              description: "Fund failed, trying again...",
              task: async state => {
                const {
                  failedDueToBadCalculation
                }: { failedDueToBadCalculation: boolean } = state;
                if (failedDueToBadCalculation) {
                  const { fundAmount, addLiquidityActions } = state;
                  const backupFundAction = multiContractAction.fund(
                    vxm.wallet.isAuthenticated,
                    number_to_asset(
                      Number(fundAmount) * 0.96,
                      new Symbol(relay.smartToken.symbol, 4)
                    ).to_string()
                  );

                  const newActions = [...addLiquidityActions, backupFundAction];
                  const txRes = await this.triggerTx(newActions);
                  return { txRes };
                }
              }
            },
            {
              description: "Waiting for catchup...",
              task: async () => wait(5000)
            },
            {
              description: `Checking and collecting any left over dust...`,
              task: async () => {
                const bankBalances = await this.fetchBankBalances({
                  smartTokenSymbol: relay.smartToken.symbol,
                  accountHolder: this.isAuthenticated
                });

                const aboveZeroBalances = bankBalances
                  .map(balance => ({
                    ...balance,
                    quantity: new Asset(balance.quantity)
                  }))
                  .filter(balance => asset_to_number(balance.quantity) > 0);

                const withdrawActions = aboveZeroBalances.map(balance =>
                  multiContract.withdrawAction(balance.symbl, balance.quantity)
                );
                if (withdrawActions.length > 0) {
                  await this.triggerTx(withdrawActions);
                }
              }
            }
          ],
          onUpdate
        });

        vxm.tlosNetwork.pingTillChange({ originalBalances });
        return finalState.txRes.transaction_id as string;
      }
    */
  @action async fetchBankBalances({
    smartTokenSymbol,
    accountHolder
  }: {
    smartTokenSymbol: string;
    accountHolder: string;
  }): Promise<{ symbl: string; quantity: string }[]> {
    const res: {
      rows: { symbl: string; quantity: string }[];
    } = await rpc.get_table_rows({
      code: process.env.VUE_APP_MULTICONTRACT!,
      scope: accountHolder,
      table: "accounts"
    });
    return res.rows.filter(row => compareString(row.symbl, smartTokenSymbol));
  }

  @action async relayById(id: string) {
    return findOrThrow(
      this.relaysList,
      relay => compareString(relay.id, id),
      `failed to find a pool by id of ${id}`
    );
  }

  @action async viewAmountToTokenAmounts(
    amounts: ViewAmount[]
  ): Promise<TokenAmount[]> {
    return Promise.all(
      amounts.map(
        async (amount): Promise<TokenAmount> => {
          const token = await this.tokenById(amount.id);
          return {
            contract: token.contract,
            amount: number_to_asset(
              Number(amount.amount),
              await this.idToSymbol(token.id)
            )
          };
        }
      )
    );
  }

  @action async doubleLiquidateActions({
    relay,
    smartTokenAmount,
    reserveAssets
  }: {
    relay: EosMultiRelay;
    smartTokenAmount: Asset;
    reserveAssets: Asset[];
  }) {
    if (reserveAssets.length !== 2)
      throw new Error("Was expecting only 2 reserve assets");
    const actions = reserveAssets.map(reserveAsset =>
      liquidateAction(
        pureTimesAsset(smartTokenAmount, 0.5),
        relay.smartToken.contract,
        number_to_asset(0, reserveAsset.symbol),
        relay.contract,
        this.isAuthenticated
      )
    );

//    console.log("doubleLiquidateActions : ", actions);
    return actions;
  }

  @action async removeLiquidity({
    reserves,
    id: relayId,
    onUpdate
  }: LiquidityParams): Promise<string> {
    const relay = await this.relayById(relayId);
//    console.log("removeLiquidity", relay);

    const supply = await fetchTokenStats(
      relay.smartToken.contract,
      relay.smartToken.symbol
    );

    const { smartTokenAmount } = await this.calculateOpposingWithdraw({
      id: relayId,
      reserve: reserves[0]
    });

    const percentChunkOfRelay =
      asset_to_number(smartTokenAmount) / asset_to_number(supply.supply);

    const bigPlaya = percentChunkOfRelay > 0.3;

    if (bigPlaya)
      throw new Error(
        "This trade makes more than 30% of the pools liquidity, it makes sense use another method for withdrawing liquidity manually due to potential slippage. Please engage us on the Telegram channel for more information."
      );

    const reserveAssets = await this.viewAmountToTokenAmounts(reserves);
    if (reserveAssets.length !== 2)
      throw new Error("Anything other than 2 reserves not supported");

    const maxSlippage = 0.01;
    let suggestTxs = parseInt(String(percentChunkOfRelay / maxSlippage));
    if (suggestTxs == 0) suggestTxs = 1;

    const tooSmall =
      asset_to_number(pureTimesAsset(smartTokenAmount, 1 / suggestTxs)) == 0;
    if (tooSmall) suggestTxs = 1;

    const steps = Array(suggestTxs)
      .fill(null)
      .map((_, i) => ({
        name: `Withdraw${i}`,
        description: `Withdrawing Liquidity stage ${i + 1}`
      }));

    let lastTxId: string = "";
    for (var i = 0; i < suggestTxs; i++) {
      onUpdate!(i, steps);
      let txRes = await this.triggerTx(
        await this.doubleLiquidateActions({
          relay,
          reserveAssets: reserveAssets.map(asset => asset.amount),
          smartTokenAmount: pureTimesAsset(smartTokenAmount, 1 / suggestTxs)
        })
      );
      lastTxId = txRes.transaction_id as string;
    }
    return lastTxId;
  }

  @action async waitAndUpdate(time: number = 4000) {
    await wait(time);
    // @ts-ignore
    return this.init();
  }

  @action async expectNewRelay(smartToken: string) {
    const attempts = 10;
    const waitPeriod = 1000;
    for (let i = 0; i < attempts; i++) {
      const relays = await fetchMultiRelays();
      const includesRelay = relays.find(relay =>
        compareString(relay.smartToken.symbol, smartToken)
      );
      if (includesRelay) {
        this.setMultiRelays(relays);
        this.refreshBalances(
          includesRelay.reserves.map(reserve => ({
            contract: reserve.contract,
            symbol: reserve.symbol
          }))
        );
        return;
      }
      await wait(waitPeriod);
    }
  }

  @mutation updateMultiRelays(relays: EosMultiRelay[]) {
    const meshedRelays = _.uniqWith(
      [...relays, ...this.relaysList],
      compareEosMultiRelay
    );
    this.relaysList = meshedRelays;
  }

  @action async fetchRelayReservesAsAssets(id: string): Promise<TokenAmount[]> {
    const relay = await this.relayById(id);

    if (relay.isMultiContract) {
      const hydratedRelay = await fetchMultiRelay(relay.smartToken.symbol);
      return hydratedRelay.reserves.map(agnosticToTokenAmount);
    } else {
      const dryRelay = multiToDry(relay);
      const [hydrated] = await this.hydrateOldRelays([dryRelay]);
      return hydrated.reserves.map(agnosticToTokenAmount);
    }
  }

  @action async accountChange() {}

  @action async getUserBalances(relayId: string) {
    const relay = await this.relayById(relayId);
    const [[smartTokenBalance], reserves, supply] = await Promise.all([
      vxm.tlosNetwork.getBalances({
        tokens: [
          {
            contract: relay.smartToken.contract,
            symbol: relay.smartToken.symbol
          }
        ]
      }),
      this.fetchRelayReservesAsAssets(relayId),
      fetchTokenStats(relay.smartToken.contract, relay.smartToken.symbol)
    ]);

    const smartSupply = asset_to_number(supply.supply);
    const percent = smartTokenBalance.balance / smartSupply;

    const maxWithdrawals: ViewAmount[] = reserves.map(reserve => ({
      id: buildTokenId({
        contract: reserve.contract,
        symbol: reserve.amount.symbol.code().to_string()
      }),
      amount: String(asset_to_number(reserve.amount) * percent)
    }));

    return {
      maxWithdrawals,
      smartTokenBalance: String(smartTokenBalance.balance)
    };
  }

  @action async tokenSupplyAsAsset({
    contract,
    symbol
  }: {
    contract: string;
    symbol: string;
  }): Promise<Asset> {
    const stats = await fetchTokenStats(contract, symbol);
    return stats.supply;
  }

  @action async calculateOpposingDeposit(
    suggestedDeposit: OpposingLiquidParams
  ): Promise<EosOpposingLiquid> {
    const relay = await this.relayById(suggestedDeposit.id);
    const [reserves, supply] = await Promise.all([
      this.fetchRelayReservesAsAssets(relay.id),
      this.tokenSupplyAsAsset({
        contract: relay.smartToken.contract,
        symbol: relay.smartToken.symbol
      })
    ]);

    const sameAsset = await this.viewAmountToAsset(suggestedDeposit.reserve);

    const tokenAmount = suggestedDeposit.reserve.amount;

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves.map(reserve => reserve.amount),
      assetToSymbolName,
      [assetToSymbolName(sameAsset)]
    );

    const reserveBalance = asset_to_number(sameReserve);
    const percent = Number(tokenAmount) / reserveBalance;
    const opposingNumberAmount = percent * asset_to_number(opposingReserve);

    const opposingAsset = number_to_asset(
      opposingNumberAmount,
      opposingReserve.symbol
    );

    const sameReserveFundReturn = calculateFundReturn(
      sameAsset,
      sameReserve,
      supply
    );
    const opposingReserveFundReturn = calculateFundReturn(
      opposingAsset,
      opposingReserve,
      supply
    );

    const lowerAsset = lowestAsset(
      sameReserveFundReturn,
      opposingReserveFundReturn
    );

    return {
      opposingAmount: String(asset_to_number(opposingAsset)),
      smartTokenAmount: lowerAsset
    };
  }

  @action async idToSymbol(id: string): Promise<Sym> {
//    console.log("idToSymbol : ", id);
    const token = await this.tokenById(id);
    return new Sym(token.symbol, token.precision);
  }

  @action async viewAmountToAsset(amount: ViewAmount): Promise<Asset> {
    return number_to_asset(
      Number(amount.amount),
      await this.idToSymbol(amount.id)
    );
  }

  @action async calculateOpposingWithdraw(
    suggestWithdraw: OpposingLiquidParams
  ): Promise<EosOpposingLiquid> {
    const relay = await this.relayById(suggestWithdraw.id);

    const sameAmountAsset = await this.viewAmountToAsset(
      suggestWithdraw.reserve
    );

    const tokenAmount = suggestWithdraw.reserve.amount;

    const [reserves, supply, smartUserBalanceString] = await Promise.all([
      this.fetchRelayReservesAsAssets(suggestWithdraw.id),
      fetchTokenStats(relay.smartToken.contract, relay.smartToken.symbol),
      getBalance(relay.smartToken.contract, relay.smartToken.symbol) as Promise<
        string
      >
    ]);

    const smartUserBalance = new Asset(smartUserBalanceString);
    const smartSupply = asset_to_number(supply.supply);

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves.map(reserve => reserve.amount),
      assetToSymbolName,
      [assetToSymbolName(sameAmountAsset)]
    );

    const reserveBalance = asset_to_number(sameReserve);
    const percent = Number(tokenAmount) / reserveBalance;

    // Added this to correct error where withdrawal was 2x what was requested
    const smartTokenAmount = (percent * smartSupply) / 2.0;

    const opposingAmountNumber = percent * asset_to_number(opposingReserve);
    const opposingAsset = number_to_asset(
      opposingAmountNumber,
      opposingReserve.symbol
    );

    return {
      opposingAmount: String(asset_to_number(opposingAsset)),
      smartTokenAmount:
        smartTokenAmount / asset_to_number(smartUserBalance) > 0.99
          ? smartUserBalance
          : number_to_asset(smartTokenAmount, smartUserBalance.symbol)
    };
  }

  @action async focusSymbol(id: string) {
    const reserveToken = this.tokens.find(token => compareString(token.id, id));

    if (reserveToken) {
      const tokens: TokenBalanceParam[] = [
        {
          contract: reserveToken.contract,
          symbol: reserveToken.symbol,
          precision: reserveToken.precision
        }
      ];
      await this.fetchTokenBalancesIfPossible(tokens);
    } else {
      const token = findOrThrow(this.tokenMeta, meta =>
        compareString(meta.id, id)
      );
      const tokens: TokenBalanceParam[] = [
        { contract: token.account, symbol: token.symbol }
      ];
      await this.fetchTokenBalancesIfPossible(tokens);
    }
  }

  @action async hasExistingBalance({
    contract,
    symbol
  }: {
    contract: string;
    symbol: string;
  }) {
    try {
      const res: { rows: { balance: string }[] } = await rpc.get_table_rows({
        code: contract,
        scope: this.isAuthenticated,
        table: "accounts"
      });
      return (
        res.rows.length > 0 &&
        res.rows
          .map(({ balance }) => balance)
          .some(balance => balance.includes(symbol))
      );
    } catch (e) {
      console.log("Balance error", e);
      return false;
    }
  }

  @action async tokenById(id: string) {
//    console.log("tokenById : ", id);
    return findOrThrow(
      this.relaysList.flatMap(relay => relay.reserves),
      token => compareString(token.id, id),
      `failed to find token by its ID of ${id}`
    );
  }

  @action async convert(proposal: ProposedConvertTransaction) {
    const { from, to } = proposal;
    if (compareString(from.id, to.id))
      throw new Error("Cannot convert a token to itself.");
    const fromAmount = from.amount;
    const toAmount = Number(to.amount);

    const [fromToken, toToken] = await Promise.all([
      this.tokenById(from.id),
      this.tokenById(to.id)
    ]);

    const fromSymbolInit = new Symbol(fromToken.symbol, fromToken.precision);
    const toSymbolInit = new Symbol(toToken.symbol, toToken.precision);
    const assetAmount = number_to_asset(Number(fromAmount), fromSymbolInit);

    const allRelays = this.convertableRelays;
    const path = await this.findPath({
      fromId: fromToken.id,
      toId: toToken.id,
      relays: allRelays.map(multiToDry)
    });
    const convertPath = relaysToConvertPaths(fromSymbolInit, path);

    const isAuthenticated = this.isAuthenticated;

    const memo = composeMemo(
      convertPath,
      String((toAmount * 0.96).toFixed(toSymbolInit.precision())),
      isAuthenticated
    );

    const fromTokenContract = fromToken.contract;
    let convertActions = await multiContract.convert(
      fromTokenContract,
      assetAmount,
      memo
    );

    const toContract = toToken.contract;
    const toSymbol = toToken.symbol;

    const existingBalance = await this.hasExistingBalance({
      contract: toContract,
      symbol: toSymbol
    });

    if (!existingBalance) {
      const openActions = await this.generateOpenActions({
        contract: toToken.contract,
        symbol: toSymbolInit
      });
      convertActions = [...openActions, ...convertActions];
    }

    const txRes = await this.triggerTxAndWatchBalances({
      actions: convertActions,
      tokenIds: [from.id, to.id]
    });

    this.refresh();
    return txRes.transaction_id;
  }

  @action async generateOpenActions({
    contract,
    symbol
  }: {
    contract: string;
    symbol: Sym;
  }) {
    const openSupported = await tokenContractSupportsOpen(contract);
    if (!openSupported)
      throw new Error(
        `You do not have an existing balance of ${symbol} and it's token contract ${contract} does not support 'open' functionality.`
      );
    const openActions = await multiContract.openActions(
      contract,
      symbol.toString(true),
      this.isAuthenticated
    );
    return openActions;
  }

  @action async triggerTxAndWatchBalances({
    actions,
    tokenIds
  }: {
    actions: any[];
    tokenIds: string[];
  }) {
    const fullTokens = await Promise.all(
      tokenIds.map(tokenId => this.tokenById(tokenId))
    );
    const tokens: BaseToken[] = fullTokens;
    const [txRes, originalBalances] = await Promise.all([
      this.triggerTx(actions),
      vxm.tlosNetwork.getBalances({
        tokens
      })
    ]);
    vxm.tlosNetwork.pingTillChange({ originalBalances });
    return txRes;
  }

  @action async hydrateV1Relays(
    v1Relays: DryRelay[]
  ): Promise<HydratedRelay[]> {
    if (v1Relays.length == 0) return [];
    const hydrated = await this.hydrateOldRelays(v1Relays);
    return hydrated.map(eosMultiToHydrated);
  }

  @action async hydrateRelays(relays: DryRelay[]): Promise<HydratedRelay[]> {
    const v1Relays = relays.filter(relay => !relay.isMultiContract);
    const v2Relays = relays.filter(relay => relay.isMultiContract);
    const [v1, v2] = await Promise.all([
      this.hydrateV1Relays(v1Relays),
      this.hydrateV2Relays(v2Relays)
    ]);
    const flat = [...v2, ...v1];
    return relays.map(
      relay =>
        flat.find(
          r =>
            r.smartToken.symbol.isEqual(relay.smartToken.symbol) &&
            compareString(r.smartToken.contract, relay.smartToken.contract)
        )!
    );
  }

  @action async hydrateV2Relays(relays: DryRelay[]): Promise<HydratedRelay[]> {
    if (relays.length == 0) return [];

    const freshRelays = await fetchMultiRelays();
    const hydratedRelays = freshRelays.map(eosMultiToHydrated);

    const result = hydratedRelays.filter(relay =>
      relays.some(
        r =>
          compareString(relay.smartToken.contract, r.smartToken.contract) &&
          relay.smartToken.symbol.isEqual(r.smartToken.symbol)
      )
    );
    if (relays.length !== result.length)
      throw new Error(
        "Failed to hydrate all relays requested in hydrateV2Relays"
      );
    return result;
  }

  @action async findPath({
    fromId,
    toId,
    relays
  }: {
    fromId: string;
    toId: string;
    relays: DryRelay[];
  }): Promise<DryRelay[]> {
    const path = await findNewPath(fromId, toId, relays, dryToTraditionalEdge);
    return path.hops.flatMap(hop => hop[0]);
  }

  @action async getReturn({
    from,
    toId
  }: ProposedFromTransaction): Promise<ConvertReturn> {
    if (compareString(from.id, toId))
      throw new Error("Cannot convert a token to itself.");
    const assetAmount = await this.viewAmountToAsset(from);

    const allRelays = this.convertableRelays.map(multiToDry);
    const path = await this.findPath({
      fromId: from.id,
      toId: toId,
      relays: allRelays
    });

    const hydratedRelays = await this.hydrateRelays(path);

    const calculatedReturn = findReturn(assetAmount, hydratedRelays);

    return {
      amount: String(asset_to_number(calculatedReturn.amount)),
      slippage: calculatedReturn.highestSlippage
    };
  }

  @action async getCost({ fromId, to }: ProposedToTransaction) {
    if (compareString(fromId, to.id))
      throw new Error("Cannot convert a token to itself.");
    const assetAmount = await this.viewAmountToAsset(to);

    const allRelays = this.convertableRelays.map(multiToDry);
    const path = await this.findPath({
      fromId,
      toId: to.id,
      relays: allRelays
    });
    const hydratedRelays = await this.hydrateRelays(path);
    const calculatedCost = findCost(assetAmount, hydratedRelays);

    return {
      amount: String(asset_to_number(calculatedCost.amount)),
      slippage: calculatedCost.highestSlippage
    };
  }

  @action async triggerTx(actions: any[]) {
    // @ts-ignore
    return this.$store.dispatch("tlosWallet/tx", actions, { root: true });
  }

  @mutation setMultiRelays(relays: EosMultiRelay[]) {
    this.relaysList = relays;
  }

  @mutation setTlosPrice(price: number) {
    this.usdPriceOfTlos = price;
  }

  @mutation setTlos24hPriceMove(priceMove: number) {
    this.usdTlos24hPriceMove = priceMove;
  }

  @mutation setTokenMeta(tokens: TokenMeta[]) {
    this.tokenMeta = tokens.filter(token => compareString(token.chain, "eos"));
  }
}
