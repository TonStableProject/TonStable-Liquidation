import {
  Address,
  beginCell,
  Builder,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Dictionary,
  DictionaryKeyTypes,
  parseTuple,
  Sender,
  SendMode,
  Slice,
  TupleItemSlice,
  TupleBuilder,
  serializeTuple,
  toNano,
  TupleItem,
} from "@ton/core";
import { Maybe } from "@ton/core/dist/utils/maybe";
import { KeyPair, sign, getSecureRandomBytes } from "@ton/crypto";
import { JettonWallet } from "./JettonWallet";

export type ApyTimeline = { ts: number; rate: bigint }[];

export function addressToHash(a: Address): bigint {
  return BigInt(
    "0x" + beginCell().storeAddress(a).endCell().hash().toString("hex"),
  );
}

export function calculateAccruedInterest(
  checkpoint: number,
  apyTimeline: ApyTimeline,
  debt: bigint,
  lastUpdate: number,
): bigint {
  let onGoingRate = 0n;
  let accrued = 0n;

  for (let i of apyTimeline) {
    if (i.ts > lastUpdate) {
      accrued +=
        (debt * BigInt(i.ts - lastUpdate) * onGoingRate) /
        (86400n * 365n) /
        100000000n;
      lastUpdate = i.ts;
    }
    onGoingRate = i.rate;
  }

  if (checkpoint > lastUpdate) {
    accrued +=
      (debt * BigInt(checkpoint - lastUpdate) * onGoingRate) /
      (86400n * 365n) /
      100000000n;
  }

  return accrued;
}

export function calculateTotalDebt(
  when: number,
  debts: Cell,
  apyTimeline: ApyTimeline,
) {
  let principalDebt: bigint = 0n;
  let interestsDebt: bigint = 0n;
  let debtsDict = Dictionary.load(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Cell(),
    beginCell().storeMaybeRef(debts).endCell(),
  );

  for (let x of debtsDict.keys()) {
    let debt = debtsDict.get(x)!;
    let debtSlice = debt.beginParse();
    let debtAmount = debtSlice.loadCoins();
    let startTs = debtSlice.loadUint(32);
    let accruedInterests = debtSlice.loadCoins();
    let createdAt = debtSlice.loadUint(32);
    principalDebt += debtAmount;
    interestsDebt +=
      accruedInterests +
      calculateAccruedInterest(when, apyTimeline, debtAmount, startTs);
  }

  return {
    principalDebt,
    interestsDebt,
  };
}

export type SupportedAsset = {
  key: bigint;
  minterAddress: Address;
  walletCode: Cell;
  params: {
    assetType: number;
    exchangeRatio: bigint;
    exchangeRatioTs: number;
    wrappedMinterAddress: Address | undefined;
    priceFeedAddress: Address | undefined;
  };
};

export type SingletonMinter = {
  address: Address;
  minterCode: Cell;
  walletCode: Cell;
};

export type ExchangeRatioData = {
  minter: Address;
  ratio: bigint;
  ts: number;
};

export type PriceData = {
  minter: Maybe<Address>;
  price: bigint;
  ts: number;
};

export type SingleTonState = {
  owner: Address;
  feeController: Address;
  protocolAccount: Address;
  minter: SingletonMinter | null;
  totalDeposits: Map<bigint, bigint>;
  totalBorrows: bigint;
  supportedAssets: Map<bigint, SupportedAsset>;
  prices: Map<bigint | null, bigint>;
  positionSafeLine: number;
  positionLiquidationLine: number;
  apyTimeline: ApyTimeline;
  liquidationPenalty: bigint;
  liquidationPenaltySplit: bigint;
};

export type BaseAsset = {
  address: Address;
  ratio: bigint;
  amount: bigint;
};

export type UserPosition = {
  owner: Address;
  state: number;
  credit: bigint;
  safeCredit: bigint;
  totalDebt: bigint;
  baseAssets: Cell;
  effectBaseAssets: BaseAsset[];
  outstandingDebt: bigint;
  interestDebt: bigint;
  borrowAmount: bigint;
  debtAccruedInterest: bigint;
};

export type SingleTonConfig = {
  ownerAddress: Address;
  feeController: Address;
  protocolAccount: Address;
  maybeMinter: Maybe<Cell>;
  maybeOracle: Maybe<Cell>;
  signerCount: number;
  signerThreshold: number;
  signers: Maybe<Dictionary<bigint, Maybe<Cell>>>;
  supportedAssets: Maybe<Dictionary<bigint, Cell>>;
  prices: Maybe<Dictionary<bigint, Cell>>;
  tokenCustody: Maybe<Dictionary<bigint, Cell>>;
  apyRate: bigint;
  positionSafeLine: number;
  positionLiquidationLine: number;
  positions: Maybe<Dictionary<bigint, Cell>>;
  liquidationPenalty: bigint;
  liquidationPenaltySplit: bigint;
  validTimestampRange: number;
};

export function singleTonConfigToCell(config: SingleTonConfig): Cell {
  const now = Math.floor(new Date().getTime() / 1000);
  return (
    beginCell()
      // configs
      .storeRef(
        beginCell()
          .storeRef(
            beginCell()
              .storeAddress(config.ownerAddress)
              .storeAddress(config.feeController)
              .storeAddress(config.protocolAccount)
              .endCell(),
          )
          .storeMaybeRef(config.maybeMinter)
          .storeRef(
            beginCell()
              .storeMaybeRef(config.maybeOracle)
              .storeUint(config.signerCount, 8)
              .storeUint(config.signerThreshold, 8)
              .storeDict(
                config.signers,
                Dictionary.Keys.BigUint(256),
                Dictionary.Values.Cell(),
              )
              .storeUint(config.validTimestampRange, SingleTon.BITS_TIMESTAMP)
              .endCell(),
          )
          .endCell(),
      )
      // states
      .storeRef(
        beginCell()
          .storeUint(0, 1)
          .storeRef(
            beginCell()
              .storeDict(null)
              .storeDict(null)
              .storeRef(
                beginCell()
                  .storeCoins(0)
                  .storeUint(now, SingleTon.BITS_TIMESTAMP)
                  .storeCoins(0)
                  .endCell(),
              )
              .endCell(),
          )
          .storeDict(config.supportedAssets)
          .storeDict(config.prices)
          .storeDict(config.tokenCustody)
          .endCell(),
      )
      // global position configs
      .storeRef(
        beginCell()
          .storeDict(
            Dictionary.empty().set(now, config.apyRate),
            Dictionary.Keys.Uint(SingleTon.BITS_TIMESTAMP),
            Dictionary.Values.BigUint(SingleTon.BITS_RATIO),
          )
          .storeUint(config.positionSafeLine, 32)
          .storeUint(config.positionLiquidationLine, 32)
          .storeUint(config.liquidationPenalty, 64)
          .storeUint(config.liquidationPenaltySplit, 64)
          .endCell(),
      )
      // positions
      .storeDict(config.positions)
      .endCell()
  );
}

export class SingleTon implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static readonly DEFAULT_TON_PRICE_KEY: string =
    "0xa1bb2a842d54edb8942f95bedaf53923d2d788d698232cfb256571e9e8b10a86";

  static readonly FEE_UPLOAD_PRICE: bigint = toNano("0.08");
  static readonly FEE_DEPOSIT: bigint = toNano("0.5");
  static readonly FEE_MINT: bigint = toNano("0.1");
  static readonly FEE_PRINT: bigint = toNano("0.5");
  static readonly FEE_JETTON_TRANSFER: bigint = toNano("0.05");
  static readonly FEE_JETTON_BURN_INTERNAL: bigint = toNano("0.05");
  static readonly FEE_LIQUIDATE_BASE: bigint = toNano("0.5");
  static readonly FEE_FREE_CUSTODY: bigint = toNano("0.15");
  static readonly FEE_WITHDRAW: bigint = toNano("0.2");
  static readonly FEE_REPAY: bigint = toNano("0.5");
  static readonly FEE_EXTRACT_ACCRUED: bigint = toNano("0.1");

  static readonly OP_SET_JETTON_MINTER: number = 0xf9e4410c;
  static readonly OP_UPDATE_SUPPORTED_ASSET: number = 0x831b84ee;
  static readonly OP_UPLOAD_PRICE_LOCAL: number = 0xa8266aea;
  static readonly OP_REPAY: number = 0x81c07b20;
  static readonly OP_LIQUIDATE: number = 0x7df2105d;
  static readonly OP_DEPOSIT: number = 0x9843c87a;
  static readonly OP_PRINTUSD: number = 0x75e4e458;
  static readonly OP_WITHDRAW: number = 0x153d36db;
  static readonly OP_TRANSFER_NOTIFICATION: number = 0x7362d09c;
  static readonly OP_STDERR: number = 0x11923a22;
  static readonly OP_FREE_CUSTODY: number = 0xcf9d3024;
  static readonly OP_UPGRADE: number = 0x7b706781;
  static readonly OP_EXTRACT_TON: number = 0x86003632;
  static readonly OP_EXTRACT_PROTOCOL_ACCRUED_PROFITS = 0x27685417;
  static readonly OP_UPLOAD_EXCHANGE_RATE = 0xd4364ee5;

  static readonly OP_CHANGE_OWNER: number = 0x19c2fbd5;
  static readonly OP_CHANGE_PROTOCOL_ACCOUNT: number = 0x946e80c1;
  static readonly OP_CHANGE_UPLOAD_PRICE_SIGNER: number = 0xf1c69c76;
  static readonly OP_CHANGE_UPLOAD_PRICE_SIGNER_THRESHOLD: number = 0x6c9caac2;
  static readonly OP_CHANGE_APY: number = 0x2bf68fb5;
  static readonly OP_CHANGE_POSITION_SAFE_LINE: number = 0x9342680a;
  static readonly OP_CHANGE_POSITION_LIQUIDATION_LINE: number = 0x23bec1b6;
  static readonly OP_CHANGE_LIQUIDATION_PENALTY: number = 0x3390c577;
  static readonly OP_CHANGE_LIQUIDATION_PENALTY_SPLIT: number = 0xe81c99a5;

  static readonly ASSETTYPE_WRAP_TON = 1;
  static readonly ASSETTYPE_SIMPLE = 2;
  static readonly ASSETTYPE_WRAP = 3;

  static readonly BITS_OP = 32;
  static readonly BITS_QUERY_ID = 64;
  static readonly BITS_RATIO = 64;
  static readonly BITS_TYPE = 8;
  static readonly BITS_PRICE_VALUE = 256;
  static readonly BITS_TIMESTAMP = 32;

  static readonly BYTES_PUBKEY = 32;
  static readonly BYTES_SIGNATURE = 64;

  static readonly AMOUNT_TYPE_CAPITAL_MAX = 0;
  static readonly AMOUNT_TYPE_VALUE_MIN = 1;

  static createFromAddress(address: Address) {
    return new SingleTon(address);
  }

  static createFromConfig(config: SingleTonConfig, code: Cell, workchain = 0) {
    const data = singleTonConfigToCell(config);
    const init = { code, data };
    return new SingleTon(contractAddress(workchain, init), init);
  }

  static calcLiquidateFee(numOfBaseAssets: number) {
    return this.FEE_LIQUIDATE_BASE;
    // return (
    //   this.FEE_LIQUIDATE_BASE +
    //   BigInt(numOfBaseAssets * 2) * this.FEE_JETTON_TRANSFER +
    //   this.FEE_JETTON_TRANSFER +
    //   this.FEE_JETTON_BURN_INTERNAL
    // );
  }

  // static signPriceData(minter: Maybe<Address>, price: bigint, ts: number, signer: KeyPair): Buffer {
  //   let dataBuilder = beginCell()
  //     .storeMaybeRef(!!minter ? beginCell().storeAddress(minter).endCell() : null)
  //     .storeUint(price, this.BITS_PRICE_VALUE)
  //     .storeUint(ts, this.BITS_TIMESTAMP)
  //     .storeBuffer(signer.publicKey, this.BYTES_PUBKEY);

  //   return sign(dataBuilder.endCell().hash(), signer.secretKey);
  // }

  // static packPriceData(minter: Maybe<Address>, price: bigint, ts: number, signer: Buffer, signature: Buffer): Cell {
  //   let dataBuilder = beginCell()
  //     .storeMaybeRef(!!minter ? beginCell().storeAddress(minter).endCell() : null)
  //     .storeUint(price, this.BITS_PRICE_VALUE)
  //     .storeUint(ts, this.BITS_TIMESTAMP)
  //     .storeBuffer(signer, this.BYTES_PUBKEY);

  //   let sigCell = beginCell().storeBuffer(signature, this.BYTES_SIGNATURE).endCell();
  //   return beginCell().storeRef(dataBuilder.endCell()).storeRef(sigCell).endCell();
  // }

  static packUnsignedPriceData(data: PriceData[], signerPubkey: Buffer): Cell {
    let tb = new TupleBuilder();
    for (let i in data) {
      tb.writeCell(
        beginCell()
          .storeMaybeRef(
            data[i].minter
              ? beginCell().storeAddress(data[i].minter).endCell()
              : null,
          )
          .storeUint(data[i].price, SingleTon.BITS_PRICE_VALUE)
          .storeUint(data[i].ts, SingleTon.BITS_TIMESTAMP)
          .endCell(),
      );
    }

    return beginCell()
      .storeRef(serializeTuple(tb.build()))
      .storeBuffer(signerPubkey, 32)
      .endCell();
  }

  static packUnsignedExchangeRatioData(
    data: ExchangeRatioData[],
    signerPubkey: Buffer,
  ): Cell {
    let tb = new TupleBuilder();
    for (let i in data) {
      tb.writeCell(
        beginCell()
          .storeAddress(data[i].minter)
          .storeUint(data[i].ratio, SingleTon.BITS_RATIO)
          .storeUint(data[i].ts, SingleTon.BITS_TIMESTAMP)
          .endCell(),
      );
    }

    return beginCell()
      .storeRef(serializeTuple(tb.build()))
      .storeBuffer(signerPubkey, 32)
      .endCell();
  }

  static packSigned(unsigned: Cell, signer: KeyPair): Cell {
    return beginCell()
      .storeRef(unsigned)
      .storeBuffer(sign(unsigned.hash(), signer.secretKey), 64)
      .endCell();
  }

  static makeDepositRequest(
    minter: Address,
    pricesCell?: Cell,
    exchangeRatiosCell?: Cell,
  ): Cell {
    let ret = beginCell()
      .storeUint(SingleTon.OP_DEPOSIT, 32)
      .storeAddress(minter);

    if (!!pricesCell) {
      ret.storeRef(pricesCell);
    }

    if (!!exchangeRatiosCell) {
      ret.storeRef(exchangeRatiosCell);
    }

    return ret.endCell();
  }

  static makeLiquidationRequest(
    positionOwner: Address,
    collaterals: TupleItem[],
    amount: bigint,
    amountType: number,
    pricesCell?: Cell,
    exchangeRatiosCell?: Cell,
  ): Cell {
    let ret = beginCell()
      .storeUint(SingleTon.OP_LIQUIDATE, 32)
      .storeAddress(positionOwner)
      .storeRef(serializeTuple(collaterals))
      .storeCoins(amount)
      .storeUint(amountType, 1);

    if (!!pricesCell) {
      ret.storeRef(pricesCell);
    }

    if (!!exchangeRatiosCell) {
      ret.storeRef(exchangeRatiosCell);
    }
    return ret.endCell();
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeStringTail("deploy").endCell(),
    });
  }

  async sendUpgrade(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    code: Cell,
    data: Cell,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_UPGRADE, SingleTon.BITS_OP)
        .storeRef(code)
        .storeRef(data)
        .endCell(),
    });
  }

  async sendExtractTon(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    amount: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_EXTRACT_TON, SingleTon.BITS_OP)
        .storeCoins(amount)
        .endCell(),
    });
  }

  async sendExtractProtocolAccruedProfits(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    amount: Maybe<bigint>,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(
          SingleTon.OP_EXTRACT_PROTOCOL_ACCRUED_PROFITS,
          SingleTon.BITS_OP,
        )
        .storeUint(123, SingleTon.BITS_QUERY_ID)
        .storeMaybeRef(
          amount ? beginCell().storeCoins(amount!).endCell() : null,
        )
        .endCell(),
    });
  }

  async sendSetJettonMinter(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    minter: Address,
    minterCode: Cell,
    walletCode: Cell,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_SET_JETTON_MINTER, SingleTon.BITS_OP)
        .storeUint(123456n, SingleTon.BITS_QUERY_ID)
        .storeAddress(minter)
        .storeRef(minterCode)
        .storeRef(walletCode)
        .endCell(),
    });
  }

  async sendUploadPrice(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    data: Cell,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_UPLOAD_PRICE_LOCAL, SingleTon.BITS_OP)
        .storeUint(12312313n, SingleTon.BITS_QUERY_ID)
        .storeRef(data)
        .endCell(),
    });
  }

  async sendUploadExchangeRate(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    data: Cell,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_UPLOAD_EXCHANGE_RATE, SingleTon.BITS_OP)
        .storeUint(12313123n, SingleTon.BITS_QUERY_ID)
        .storeRef(data)
        .endCell(),
    });
  }

  async sendAddSupportedToken(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    minter: Address,
    code: Cell,
    params: Cell,
  ) {
    let body = beginCell()
      .storeUint(SingleTon.OP_UPDATE_SUPPORTED_ASSET, SingleTon.BITS_OP)
      .storeUint(0, SingleTon.BITS_QUERY_ID)
      .storeAddress(minter)
      .storeMaybeRef(code)
      .storeRef(params);

    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body.endCell(),
    });
  }

  async sendChangeOwner(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    newOwner: Address,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_OWNER, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeAddress(newOwner)
        .endCell(),
    });
  }

  async sendChangeProtocolAccount(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    recv: Address,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_PROTOCOL_ACCOUNT, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeAddress(recv)
        .endCell(),
    });
  }

  async sendChangeUploadPriceSigner(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    signerPubkey: Buffer,
    toRemove?: boolean,
    signerAttrs?: Maybe<Cell>,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_UPLOAD_PRICE_SIGNER, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeBuffer(signerPubkey, SingleTon.BYTES_PUBKEY)
        .storeUint(toRemove ? 1 : 0, 1)
        .storeMaybeRef(signerAttrs)
        .endCell(),
    });
  }

  async sendChangeUploadPriceSignerThreshold(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    threshold: number,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(
          SingleTon.OP_CHANGE_UPLOAD_PRICE_SIGNER_THRESHOLD,
          SingleTon.BITS_OP,
        )
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(threshold, 8)
        .endCell(),
    });
  }

  async sendChangeAPY(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    apy: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_APY, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(apy, SingleTon.BITS_RATIO)
        .endCell(),
    });
  }

  async sendChangePositionSafeLine(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    safeLine: number,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_POSITION_SAFE_LINE, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(safeLine, 32)
        .endCell(),
    });
  }

  async sendChangePositionLiquidationLine(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    liquidationLine: number,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(
          SingleTon.OP_CHANGE_POSITION_LIQUIDATION_LINE,
          SingleTon.BITS_OP,
        )
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(liquidationLine, 32)
        .endCell(),
    });
  }

  async sendChangeLiquidationPenalty(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    penalty: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(SingleTon.OP_CHANGE_LIQUIDATION_PENALTY, SingleTon.BITS_OP)
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(penalty, SingleTon.BITS_RATIO)
        .endCell(),
    });
  }

  async sendChangeLiquidationPenaltySplit(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    split: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(
          SingleTon.OP_CHANGE_LIQUIDATION_PENALTY_SPLIT,
          SingleTon.BITS_OP,
        )
        .storeUint(0, SingleTon.BITS_QUERY_ID)
        .storeUint(split, SingleTon.BITS_RATIO)
        .endCell(),
    });
  }

  async sendDeposit(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    wallet: Address,
    depositAmount: bigint,
    minterMaster: Address,
    priceUpdates?: Cell,
    exchangeRateUpdates?: Cell,
  ) {
    if (value < SingleTon.FEE_JETTON_TRANSFER + SingleTon.FEE_DEPOSIT) {
      throw "value not enough";
    }

    const minterWallet = provider.open(JettonWallet.createFromAddress(wallet));
    await minterWallet.getJettonBalance();
    let payload = beginCell()
      .storeUint(SingleTon.OP_DEPOSIT, SingleTon.BITS_OP)
      .storeAddress(minterMaster);

    if (!!priceUpdates) {
      payload = payload.storeRef(priceUpdates);
      if (!!exchangeRateUpdates) {
        payload = payload.storeRef(exchangeRateUpdates);
      }
    }

    await minterWallet.sendTransfer(
      via,
      value, //  SingleTon.FEE_JETTON_TRANSFER + Position.FEE_DEPOSIT,
      depositAmount,
      this.address,
      this.address,
      Cell.EMPTY,
      SingleTon.FEE_DEPOSIT,
      payload.endCell(),
    );
  }

  async sendPrint(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    amount: bigint,
    max?: boolean,
    uploadPriceData?: Cell,
    uploadxTONExchangeRatios?: Cell,
  ) {
    let body = beginCell()
      .storeUint(SingleTon.OP_PRINTUSD, SingleTon.BITS_OP)
      .storeUint(
        BigInt("0x" + (await getSecureRandomBytes(8)).toString("hex")),
        SingleTon.BITS_QUERY_ID,
      )
      .storeCoins(amount)
      .storeUint(max ? 1 : 0, 1);

    if (!!uploadPriceData) {
      body.storeRef(uploadPriceData!);
    }

    if (!!uploadxTONExchangeRatios) {
      body.storeRef(uploadxTONExchangeRatios);
    }

    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body.endCell(),
    });
  }

  async sendWithdraw(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    asset: Address,
    amount: bigint,
    max?: boolean,
    uploadPriceData?: Cell,
    uploadxTONExchangeRatios?: Cell,
  ) {
    let body = beginCell()
      .storeUint(SingleTon.OP_WITHDRAW, SingleTon.BITS_OP)
      .storeUint(
        BigInt("0x" + (await getSecureRandomBytes(8)).toString("hex")),
        SingleTon.BITS_QUERY_ID,
      )
      .storeAddress(asset)
      .storeCoins(amount)
      .storeUint(max ? 1 : 0, 1);

    if (!!uploadPriceData) {
      body.storeRef(uploadPriceData);
    }
    if (!!uploadxTONExchangeRatios) {
      body.storeRef(uploadxTONExchangeRatios);
    }

    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body.endCell(),
    });
  }

  async sendRepay(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    repayWallet: Address,
    repayAmount: bigint,
    priceUpdates?: Cell,
    exchangeRateUpdates?: Cell,
  ) {
    if (value < SingleTon.FEE_REPAY) {
      throw "value not enough";
    }

    const wallet = provider.open(JettonWallet.createFromAddress(repayWallet));
    let payload = beginCell()
      .storeUint(SingleTon.OP_REPAY, SingleTon.BITS_OP)
      .storeMaybeRef();
    if (!!priceUpdates) {
      payload = payload.storeRef(priceUpdates);

      if (!!exchangeRateUpdates) {
        payload = payload.storeRef(exchangeRateUpdates);
      }
    }

    await wallet.sendTransfer(
      via,
      value, // Position.FEE_REPAY + Position.FEE_JETTON_TRANSFER,
      repayAmount,
      this.address,
      this.address,
      Cell.EMPTY,
      SingleTon.FEE_REPAY,
      payload.endCell(),
    );
  }

  async sendLiquidate(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    wantedCollaterals: Address[],
    liquidatorWalletAddress: Address,
    liquidateCapital: bigint,
    liquidateAmount: bigint,
    toBeLiquidated: Address,
    priceUpdates?: Cell,
    exchangeUpdates?: Cell,
  ) {
    let liquidatorWallet = provider.open(
      JettonWallet.createFromAddress(liquidatorWalletAddress),
    );
    let liquidateCollaterals: TupleItem[] = [];
    for (let lc of wantedCollaterals) {
      liquidateCollaterals.push({
        type: "cell",
        cell: beginCell().storeAddress(lc).endCell(),
      });
    }
    const liquidateFee = SingleTon.calcLiquidateFee(wantedCollaterals.length);
    if (value < SingleTon.FEE_JETTON_TRANSFER + liquidateFee) {
      throw "value not enough";
    }

    let payload = beginCell()
      .storeUint(SingleTon.OP_LIQUIDATE, 32)
      .storeAddress(toBeLiquidated)
      .storeRef(serializeTuple(liquidateCollaterals))
      .storeCoins(liquidateAmount)
      .storeUint(SingleTon.AMOUNT_TYPE_CAPITAL_MAX, 1);
    if (!!priceUpdates) {
      payload.storeRef(priceUpdates);
      if (!!exchangeUpdates) {
        payload.storeRef(exchangeUpdates);
      }
    }

    await liquidatorWallet.sendTransfer(
      via,
      value,
      liquidateCapital,
      this.address,
      this.address,
      Cell.EMPTY,
      liquidateFee,
      payload.endCell(),
    );
  }

  async sendRemoveSupportedToken(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    minter: Address,
  ) {
    let body = beginCell()
      .storeUint(SingleTon.OP_UPDATE_SUPPORTED_ASSET, SingleTon.BITS_OP)
      .storeUint(0, SingleTon.BITS_QUERY_ID)
      .storeAddress(minter)
      .storeMaybeRef(null);

    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body.endCell(),
    });
  }

  async sendFreeCustody(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    who: Address,
    minter: Address,
    uploadPriceData?: Cell,
  ) {
    let body = beginCell()
      .storeUint(SingleTon.OP_FREE_CUSTODY, SingleTon.BITS_OP)
      .storeUint(0, SingleTon.BITS_QUERY_ID)
      .storeAddress(who)
      .storeAddress(minter);

    if (uploadPriceData) {
      body.storeRef(uploadPriceData);
    }

    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body.endCell(),
    });
  }

  async getSingletonState(provider: ContractProvider): Promise<SingleTonState> {
    let res = await provider.get("get_singleton_state", []);
    let owner = res.stack.readAddress();
    let feeController = res.stack.readAddress();
    let protocolAccount = res.stack.readAddress();
    let _minter = res.stack.readCellOpt();
    let stats = res.stack.readCell();
    let supportedAssets = res.stack.readCellOpt();
    let prices = res.stack.readCellOpt();
    let positionSafeLine = res.stack.readNumber();
    let positionLiquidationLine = res.stack.readNumber();
    let _apyTimeline = res.stack.readCellOpt()!;
    let liquidationPenalty = res.stack.readBigNumber();
    let liquidationPenaltySplit = res.stack.readBigNumber();

    let apyTimeline: ApyTimeline = [];
    let apyD = Dictionary.loadDirect(
      Dictionary.Keys.Uint(SingleTon.BITS_TIMESTAMP),
      Dictionary.Values.BigUint(SingleTon.BITS_RATIO),
      _apyTimeline,
    );
    for (let ts of apyD.keys()) {
      apyTimeline.push({ ts, rate: apyD.get(ts)! });
    }

    let minter: SingletonMinter | null = null;
    if (!!_minter) {
      let _x = _minter!.beginParse();
      minter = {
        address: _x.loadAddress(),
        minterCode: _x.loadRef(),
        walletCode: _x.loadRef(),
      };
    }

    let totalDeposits: Map<bigint, bigint> = new Map();
    let totalBorrows: bigint = 0n;
    let supported: Map<bigint, SupportedAsset> = new Map();

    if (!!supportedAssets) {
      supported = SingleTon.parseSupportedAssets(supportedAssets!);

      if (!!stats) {
        let statsParser = stats!.beginParse();
        let _totalDeposits = statsParser.loadMaybeRef();
        let _totalBorrows = statsParser.loadMaybeRef();
        if (!!_totalDeposits) {
          let x = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.Cell(),
            beginCell().storeMaybeRef(_totalDeposits!).endCell(),
          );

          supported.forEach((asset, i, d) => {
            totalDeposits.set(addressToHash(asset.minterAddress), 0n);
            let _d = x.get(asset.key);
            if (!!_d) {
              totalDeposits.set(
                addressToHash(asset.minterAddress),
                _d.beginParse().loadCoins(),
              );
            }
          });
        }
        if (!!_totalBorrows) {
          let y = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.Cell(),
            beginCell().storeMaybeRef(_totalBorrows!).endCell(),
          );

          let husd = y.get(
            BigInt(
              "0x" +
                beginCell()
                  .storeAddress(minter!.address)
                  .endCell()
                  .hash()
                  .toString("hex"),
            ),
          );
          totalBorrows = !!husd ? husd.beginParse().loadCoins() : 0n;
        }
      }
    }

    let decodePrices = new Map();
    if (!!prices) {
      let p = Dictionary.load(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
        beginCell().storeMaybeRef(prices).endCell(),
      );
      for (let v of p.values()) {
        let x = v.beginParse();
        let minterAddress = x.loadMaybeAddress();
        let data = x.loadRef();
        let price = data.beginParse().loadUintBig(SingleTon.BITS_PRICE_VALUE);
        decodePrices.set(addressToHash(minterAddress), price);
      }
    }

    return {
      owner,
      feeController,
      protocolAccount,
      minter,
      supportedAssets: supported,
      totalDeposits,
      totalBorrows,
      prices: decodePrices,
      positionSafeLine,
      positionLiquidationLine,
      apyTimeline,
      liquidationPenalty,
      liquidationPenaltySplit,
    };
  }

  static parseSupportedAssets(c: Cell): Map<bigint, SupportedAsset> {
    let dict = Dictionary.load(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
      beginCell().storeMaybeRef(c).endCell(),
    );

    let ret: Map<bigint, SupportedAsset> = new Map();

    dict.keys().forEach((key, idx, d) => {
      let val = dict.get(key)!;
      let vs = val.beginParse();
      let minterAddress = vs.loadAddress();
      let walletCode = vs.loadRef();
      let params = vs.loadRef();
      let paramsCS = params.beginParse();
      let assetType = paramsCS.loadUint(8);
      let exchangeRatio = paramsCS.loadUintBig(this.BITS_RATIO);
      let exchangeRatioTs = paramsCS.loadUint(this.BITS_TIMESTAMP);
      let extended = paramsCS.loadRef();
      let extendedParse = extended.beginParse();
      let wrappedCell = extendedParse.loadMaybeRef();
      let wrappedMinterAddress = wrappedCell?.beginParse().loadAddress();
      let priceFeedCell = extendedParse.loadMaybeRef();
      let priceFeedAddress = priceFeedCell?.beginParse().loadAddress();
      paramsCS.endParse();

      ret.set(key, {
        key,
        minterAddress,
        walletCode,
        params: {
          assetType,
          exchangeRatio,
          exchangeRatioTs,
          wrappedMinterAddress,
          priceFeedAddress,
        },
      });
    });

    return ret;
  }

  async getUserCustodyTokens(
    provider: ContractProvider,
    who: Address,
  ): Promise<{ minterAddress: Address; amount: bigint }[]> {
    let res = await provider.get("get_user_stucked_token", [
      { type: "slice", cell: beginCell().storeAddress(who).endCell() },
    ]);
    let stucked = res.stack.readCellOpt();
    if (!stucked) {
      return [];
    }

    let tokens = Dictionary.load(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
      beginCell().storeMaybeRef(stucked).endCell(),
    );
    let ret = [];
    for (let t of tokens.values()) {
      let x = t.beginParse();
      let minterAddress = x.loadAddress();
      let amount = x.loadCoins();

      ret.push({ minterAddress, amount });
    }

    return ret;
  }

  async getProtocolAccruedProfits(provider: ContractProvider) {
    let res = await provider.get("get_protocol_accrued_profits", []);
    let totalAccrued = res.stack.readBigNumber();
    let lastUpdated = res.stack.readNumber();
    let extracted = res.stack.readBigNumber();

    return {
      totalAccrued,
      lastUpdated,
      extracted,
    };
  }

  async getAllPositions(
    provider: ContractProvider,
    offset?: number,
    limit?: number,
  ): Promise<TupleItem[]> {
    if (!offset || offset < 0) {
      offset = 0;
    }
    if (!limit || limit < 0) {
      limit = 0;
    }
    let res = await provider.get("get_all_positions", [
      { type: "int", value: BigInt(offset) },
      { type: "int", value: BigInt(limit) },
    ]);
    return res.stack.readLispList();
  }

  static parsePositionCell(position: Cell) {
    let positionParse = position.beginParse();
    let positionConfig = positionParse.loadRef();
    let positionState = positionParse.loadRef();
    positionParse.endParse();

    let positionConfigParse = positionConfig.beginParse();
    let owner = positionConfigParse.loadAddress();
    let createdAt = positionConfigParse.loadUint(SingleTon.BITS_TIMESTAMP);
    positionConfigParse.endParse();

    let positionStateParse = positionState.beginParse();
    let state = positionStateParse.loadUint(8);
    let credit = positionStateParse.loadCoins();
    let baseAssets = positionStateParse.loadDict(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    let debts = positionStateParse.loadDict(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    positionStateParse.endParse();

    return {
      owner,
      createdAt,
      state,
      credit,
      baseAssets,
      debts,
    };
  }

  async getUserPosition(
    provider: ContractProvider,
    who: Address,
    singleTonState: SingleTonState,
  ): Promise<UserPosition> {
    let res = await provider.get("get_position_state", [
      { type: "slice", cell: beginCell().storeAddress(who).endCell() },
    ]);
    let owner = res.stack.readAddress();
    let createdAt = res.stack.readBigNumber();
    let state = res.stack.readNumber();
    let credit = res.stack.readBigNumber();
    let totalDebt = res.stack.readBigNumber();
    let baseAssets = res.stack.readCellOpt();
    let debts = res.stack.readCellOpt();
    let outstandingDebt = res.stack.readBigNumber();
    let interestDebt = res.stack.readBigNumber();
    let safeCredit =
      (credit * 10000n) / BigInt(singleTonState.positionSafeLine);

    let now = Math.floor(new Date().getTime() / 1000);

    let borrowAmount = 0n;
    let accruedInterest = 0n;
    if (debts != null) {
      let _dict = Dictionary.load(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
        beginCell().storeMaybeRef(debts).endCell(),
      );
      for (let d of _dict.keys()) {
        let _debtCell = _dict.get(d)!;
        let _parser = _debtCell.beginParse();

        let _borrowAmount = _parser.loadCoins();
        let _startTs = _parser.loadUint(32);
        let _accruedInterest = _parser.loadCoins();

        borrowAmount += _borrowAmount;
        accruedInterest +=
          _accruedInterest +
          calculateAccruedInterest(
            now,
            singleTonState.apyTimeline,
            _borrowAmount,
            _startTs,
          );
      }
    }

    let effectBaseAssets: BaseAsset[] = [];
    if (baseAssets) {
      let dict = Dictionary.load(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
        beginCell().storeMaybeRef(baseAssets).endCell(),
      );

      for (let i of singleTonState.supportedAssets.keys()) {
        let addrHash = addressToHash(
          singleTonState.supportedAssets.get(i)!.minterAddress,
        );
        for (let k of dict.keys()) {
          if (k == addrHash) {
            effectBaseAssets.push({
              address: singleTonState.supportedAssets.get(i)!.minterAddress,
              ratio:
                singleTonState.supportedAssets.get(i)!.params.exchangeRatio,
              amount: dict.get(k)!.beginParse().loadCoins(),
            });
            break;
          }
        }
      }
    }

    return {
      owner,
      state,
      credit,
      safeCredit,
      totalDebt,
      baseAssets,
      effectBaseAssets,
      outstandingDebt,
      interestDebt,
      borrowAmount,
      debtAccruedInterest: accruedInterest,
    };
  }
}
