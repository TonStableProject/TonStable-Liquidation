import { getHttpV4Endpoint } from "@orbs-network/ton-access";
import {
  Address,
  OpenedContract,
  Sender,
  toNano,
  TonClient4,
  WalletContractV4,
} from "@ton/ton";
import { SingleTon, SingleTonState } from "./wrappers/SingleTon";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { JettonMinter } from "./wrappers/JettonMinter";
import { JettonWallet } from "./wrappers/JettonWallet";
import { Cell } from "@ton/core";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";

export const RATIO_DENOM = 100000000n;
export const PRICE_DENOM = 100000000n;
export const LINE_DENOM = 10000n;
const sleep = (time = 3000) => new Promise((res) => setTimeout(res, time));
interface ContractConfig {
  SingleTonContractAddress: string;
  USTGContractAddress: string;
  STTONContractAddress: string;
  TSTONContractAddress: string;
  STAKEDContractAddress: string;
  FTONContractAddress: string;
}
export class TonStableClient {
  private WALLET_MNEMONIC: string;
  private contractConfig: ContractConfig;
  client: TonClient4;
  SingleTonContract: OpenedContract<SingleTon>;
  STTONContract: OpenedContract<JettonMinter>;

  USTGWalletContract: OpenedContract<JettonWallet>;
  sender: Sender;
  walletContract: OpenedContract<WalletContractV4>;
  singletonState: SingleTonState;
  constructor(WALLET_MNEMONIC: string, contractConfig: ContractConfig) {
    this.WALLET_MNEMONIC = WALLET_MNEMONIC;
    this.contractConfig = contractConfig;
    this.init();
  }
  init = async () => {
    const endpoint = await getHttpV4Endpoint({ network: "testnet" });
    const client = new TonClient4({ endpoint });
    this.client = client;
    this.SingleTonContract = client.open(
      new SingleTon(
        Address.parse(this.contractConfig.SingleTonContractAddress),
      ),
    );
    this.STTONContract = client.open(
      new JettonMinter(Address.parse(this.contractConfig.STTONContractAddress)),
    );
    const USTGContract = client.open(
      new JettonMinter(Address.parse(this.contractConfig.USTGContractAddress)),
    );
    // return client.open(contract)
    // USTGContract.getWalletAddress(Address.parse(TonConnectUI.account.address)),

    const keyPair = await mnemonicToPrivateKey(this.WALLET_MNEMONIC.split(" "));
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });
    const wallet_address = client.open(wallet);
    this.walletContract = wallet_address;
    this.sender = wallet_address.sender(keyPair.secretKey);
    const USTGWalletContractAddress = await USTGContract.getWalletAddress(
      wallet.address,
    );
    this.USTGWalletContract = client.open(
      JettonWallet.createFromAddress(USTGWalletContractAddress),
    );
  };
  getBalance = async () => {
    if (!this.walletContract) {
      await this.init();
    }
    return this.walletContract.getBalance();
  };
  getSingletonState = async () => {
    if (!this.SingleTonContract || !this.singletonState) {
      await this.init();
      this.singletonState = await this.SingleTonContract.getSingletonState();
    }
    return this.singletonState;
  };

  mint = async () => {
    if (!this.STTONContract) {
      await this.init();
    }
    await this.STTONContract.sendMint(
      this.sender,
      Address.parse("0QBju2J41DRswrkExUM4BHv9rxkSW9GV2ePr1R4HrZKlUVBH"),
      toNano("1000"),
      0n,
      toNano("0.1"),
    );
  };
  getAllPositions = async () => {
    if (!this.SingleTonContract) {
      await this.init();
    }
    console.log("1", await this.SingleTonContract.getAllPositions());

    const list = (await this.SingleTonContract.getAllPositions())
      .filter((value) => value.type === "cell")
      .map((value) => SingleTon.parsePositionCell(value.cell));
    return list;
  };

  getUserPosition = async (address: Address) => {
    if (!this.SingleTonContract || !this.SingleTonContract) {
      await this.init();
    }
    let singletonState = await this.getSingletonState();
    console.log("singletonState", singletonState);

    const userPosition = await this.SingleTonContract.getUserPosition(
      address,
      singletonState,
    );

    const priceList = await getTONPrice();
    const TONPrice = priceList.filter((v) => v.symbol === "TON")[0].price;
    const STTONPrice = priceList.filter((v) => v.symbol === "STTON")[0].price;
    const TSONPrice = priceList.filter((v) => v.symbol === "TSTON")[0].price;
    const STAKEDPrice = priceList.filter((v) => v.symbol === "STAKED")[0].price;
    const FTONPrice = priceList.filter((v) => v.symbol === "FTON")[0].price;
    let sum = BigNumber(0);
    userPosition.effectBaseAssets.forEach((baseAsset, index) => {
      if (
        baseAsset.address.equals(
          Address.parse(this.contractConfig.STTONContractAddress),
        )
      ) {
        sum = sum.plus(
          BigNumber(baseAsset.amount.toString())
            .multipliedBy(BigNumber(STTONPrice))
            .dividedBy(PRICE_DENOM.toString()),
        );
      }
      if (
        baseAsset.address.equals(
          Address.parse(this.contractConfig.TSTONContractAddress),
        )
      ) {
        sum = sum.plus(
          BigNumber(baseAsset.amount.toString())
            .multipliedBy(BigNumber(TSONPrice))
            .dividedBy(PRICE_DENOM.toString()),
        );
      }
      if (
        baseAsset.address.equals(
          Address.parse(this.contractConfig.STAKEDContractAddress),
        )
      ) {
        sum = sum.plus(
          BigNumber(baseAsset.amount.toString())
            .multipliedBy(BigNumber(STAKEDPrice))
            .dividedBy(PRICE_DENOM.toString()),
        );
      }
      if (
        baseAsset.address.equals(
          Address.parse(this.contractConfig.FTONContractAddress),
        )
      ) {
        sum = sum.plus(
          BigNumber(baseAsset.amount.toString())
            .multipliedBy(BigNumber(FTONPrice))
            .dividedBy(PRICE_DENOM.toString()),
        );
      }
    });
    const userCurrentTotalCollateral = BigInt(sum.toFixed(0));
    return {
      ...userPosition,
      userCurrentTotalCollateral,
      positionLiquidationLine: singletonState.positionLiquidationLine,
    };
  };

  tryToLiquidate = async (toBeLiquidated: Address) => {
    if (!this.singletonState) {
      this.init();
    }
    const userPosition = await this.getUserPosition(toBeLiquidated);
    console.log("userPosition", userPosition);
    console.log(
      "userPosition.userCurrentTotalCollateral ",
      userPosition.userCurrentTotalCollateral,
    );
    const currentTotalDebt =
      userPosition.borrowAmount + userPosition.debtAccruedInterest;
    console.log(
      "userPosition.borrowAmount + userPosition.debtAccruedInterest",
      currentTotalDebt,
    );
    const capital_adequacy =
      (userPosition.userCurrentTotalCollateral * LINE_DENOM) / currentTotalDebt;
    console.log("capital_adequacy", capital_adequacy);
    const outstanding_line =
      (this.singletonState.positionSafeLine +
        this.singletonState.positionLiquidationLine) /
      2;
    if (capital_adequacy < this.singletonState.positionLiquidationLine) {
      console.log("tryToLiquidate");
      const decideLiquidatePenaltyRatios =
        await this.decideLiquidatePenaltyRatios(capital_adequacy);
      console.log("decideLiquidatePenaltyRatios", decideLiquidatePenaltyRatios);
      const outstandingDebt = await this.outstandingDebt(
        decideLiquidatePenaltyRatios._liquidation_penalty_ratio,
        BigInt(outstanding_line),
        currentTotalDebt,
        userPosition.userCurrentTotalCollateral,
      );
      console.log("outstandingDebt", outstandingDebt);
      await this.sendLiquidate(outstandingDebt, toBeLiquidated);
    }
  };

  sendLiquidate = async (outstandingDebt: bigint, toBeLiquidated: Address) => {
    if (!this.USTGWalletContract) {
      await this.init();
    }
    const liquidateCapital = outstandingDebt;
    const liquidateAmount = outstandingDebt;
    const wantedCollaterals = [
      Address.parse(this.contractConfig.STTONContractAddress),
      // Address.parse(this.contractConfig.TSTONContractAddress),
      // Address.parse(this.contractConfig.STAKEDContractAddress),
      // Address.parse(this.contractConfig.FTONContractAddress),
    ];
    const liquidateFee = SingleTon.calcLiquidateFee(wantedCollaterals.length);
    const feedData = await getFeedData();

    await this.SingleTonContract.sendLiquidate(
      this.sender,
      SingleTon.FEE_JETTON_TRANSFER + liquidateFee,
      wantedCollaterals,
      this.USTGWalletContract.address,
      liquidateCapital,
      liquidateAmount,
      toBeLiquidated,
      feedData[0],
      feedData[1],
    );
  };

  decideLiquidatePenaltyRatios = async (capital_adequacy: bigint) => {
    let capital_adequacy_ratio = (capital_adequacy * RATIO_DENOM) / LINE_DENOM;
    let singletonState = await this.getSingletonState();
    let _liquidation_penalty_ratio = singletonState.liquidationPenalty;
    let _liquidation_penalty_split_ratio =
      singletonState.liquidationPenaltySplit;
    let liquidator_gains_ratio =
      (singletonState.liquidationPenalty *
        singletonState.liquidationPenaltySplit) /
      RATIO_DENOM;

    let _type = 0;
    if (capital_adequacy_ratio <= RATIO_DENOM + liquidator_gains_ratio) {
      _liquidation_penalty_ratio = liquidator_gains_ratio;
      _liquidation_penalty_split_ratio = RATIO_DENOM;
      _type = 1;
    } else if (
      capital_adequacy_ratio >=
      RATIO_DENOM + singletonState.liquidationPenalty
    ) {
      _liquidation_penalty_ratio = singletonState.liquidationPenalty;
      _liquidation_penalty_split_ratio = singletonState.liquidationPenaltySplit;
      _type = 2;
    } else {
      _liquidation_penalty_ratio = capital_adequacy_ratio - RATIO_DENOM;
      _liquidation_penalty_split_ratio =
        (singletonState.liquidationPenaltySplit *
          singletonState.liquidationPenalty) /
        _liquidation_penalty_ratio;
      _type = 3;
    }
    return {
      _liquidation_penalty_ratio,
      _liquidation_penalty_split_ratio,
      _type,
    };
  };

  outstandingDebt = async (
    _liquidation_penalty_ratio: bigint,
    _position_safe_line: bigint,
    _total_debt: bigint,
    _total_collateral_value: bigint,
  ) => {
    if (
      (_total_collateral_value * LINE_DENOM) / _total_debt >=
      _position_safe_line
    ) {
      return 0n;
    }

    let outstanding = 0n;
    let searches = 0n;
    let min = 0n;
    let max = _total_debt;
    let debt_removed = 0n;
    let collateral_reduced = 0n;
    let capital_adequacy = (_total_collateral_value * LINE_DENOM) / _total_debt;

    while (searches < 32n) {
      debt_removed = (min + max) / 2n;
      let td = _total_debt - debt_removed;
      collateral_reduced =
        (debt_removed * (RATIO_DENOM + _liquidation_penalty_ratio)) /
        RATIO_DENOM;
      if (_total_collateral_value <= collateral_reduced) {
        outstanding = _total_debt;
        searches = 99n;
      } else {
        let tv = _total_collateral_value - collateral_reduced;
        capital_adequacy = (tv * LINE_DENOM) / td;
        if (capital_adequacy >= _position_safe_line) {
          max = debt_removed;
          if (outstanding == 0n || outstanding > debt_removed) {
            outstanding = debt_removed;
          }
        } else {
          min = debt_removed;
        }

        searches += 1n;
      }
    }

    if (outstanding == 0n) {
      outstanding = _total_debt;
    }
    console.log("searches", searches);

    return outstanding;
  };

  waitForTransaction = async (
    action: string = "transaction",
    curTxLt: string | null = null,
    maxRetry: number = 10,
    interval: number = 3000,
  ) => {
    if (!this.client) return false;
    let done = false;
    let count = 0;
    let blockNum = (await this.client.getLastBlock()).last.seqno;
    if (curTxLt == null) {
      let initialState = await this.client.getAccount(
        blockNum,
        this.walletContract.address,
      );
      let lt = initialState?.account?.last?.lt;
      curTxLt = lt ? lt : null;
    }
    do {
      console.debug(`Awaiting ${action} completion (${++count}/${maxRetry})`);
      await sleep(interval);
      let newBlockNum = (await this.client.getLastBlock()).last.seqno;
      if (blockNum == newBlockNum) {
        continue;
      }
      blockNum = newBlockNum;
      const curState = await this.client.getAccount(
        blockNum,
        this.walletContract.address,
      );
      if (curState?.account?.last !== null) {
        done = curState?.account?.last?.lt !== curTxLt;
      }
    } while (!done && count < maxRetry);
    console.debug(
      `Awaiting ${action} completion (${++count}/${maxRetry}), done ${done}`,
    );

    return done;
  };
}

export const getFeedData = async (keypair?: string) => {
  const { data } = await (
    await fetch(`https://test.tonstable.xyz/api/getfeedData`)
  ).json();
  return [
    Cell.fromBoc(Buffer.from(data[0], "hex"))[0],
    Cell.fromBoc(Buffer.from(data[1], "hex"))[0],
  ];
};
/**
 * @description price decimal 8
 * @returns
 */
export const getTONPrice: () => Promise<any[]> = async () => {
  const data = await (
    await fetch(`https://test.tonstable.xyz//api/getprice`)
  ).json();
  return data.data as any[];
};
