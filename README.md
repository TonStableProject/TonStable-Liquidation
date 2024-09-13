# TonStable Liquidation

## Liquidation

### Conditions

- Liquidation is allowed only when a position's capital adequacy ratio is below position_liquidation_line (e.g. 120%).
- The first thing a liquidator needs to do is to repay what the related position owes. So, liquidator needs to transfer USTG into SingleTon contract to start a liquidation.
- In the Jetton transfer tx payload, liquidator must specify the amount of USTG that he/she want to cover which can be part or all of the debt.
- During a liquidation act, the liquidator can choose any number of the base assets in the position as a combination of liquidation compensations. These chosen base assets will mostly be transfered to the liquidator meanwhile a minor portion will be charged as liquidation tax by Singleton.
- A position's liquidation penalty is based on the amount of USTG borrowed + the interest accrued.
- Partial liquidation always prevails full liquidation. So we set a parameter called 'outstanding_line', which is supposed to be the target capital adequacy ratio after a partial liquidation. It is defined as:

```javascript
int outstanding_line = (position_safe_line + position_liquidation_line) / 2;
```

### Transfer payload

Liquidation information will be carried in the "forward payload" of the Jetton Transfer method.
The forward payload is itself a Cell constructed by the format:
opcode:uint32 positionOwnerAddr:MsgAddress collateralAssetList:TupleList<MsgAddress> amount:Grams amountType:uint1:

- opcode: 0x7df2105d
- positionOwnerAddr: the owner's address of the position being liquidated
- collateralAssetList: a list of which assets the liquidator would take as compensations from performing liquidation
- amount: "at least this amount of USTG should be transferred into singleton to cover the borrower's debt to the protocol" or "min value the liquidator got from liquidating the position", depends on amountType below
- amountType: SingleTon.AMOUNT_TYPE_CAPITAL_MAX or SingleTon.AMOUNT_TYPE_VALUE_MIN

A basic example for liquidation in TypeScript:

```javascript
const liquidatorUSTGWallet = blockchain.openContract(
  JettonWallet.createFromAddress(
    await USTG.getWalletAddress(liquidator.address),
  ),
);
// liquidateCapital must be >= liquidateAmount
const liquidateCapital = toNano("10000");
const liquidateAmount = toNano("7450");
const wantedCollaterals = [stTon.address, xTon.address];
const liquidateFee = SingleTon.calcLiquidateFee(wantedCollaterals.length);

// sendLiquidate is just a thin wrapper over the raw sendTransfer
await singlton.sendLiquidate(
  liquidator.getSender(),
  SingleTon.FEE_JETTON_TRANSFER + liquidateFee,
  wantedCollaterals,
  liquidatorUSTGWallet.address,
  liquidateCapital,
  liquidateAmount,
  userToBeLiquidatedAddress,
  priceUpdates,
  exchangeRateUpdates,
);
```
