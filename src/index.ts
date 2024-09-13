import { TonStableClient } from "./TonStableClient";
import { WALLET_MNEMONIC } from "./config";
export { TonStableClient } from "./TonStableClient";

const CONSTANTS = {
  SingleTonContractAddress: "EQDM1pwnzPipG7aOUCqT040kZDZl83svyCIDwRwh9pTHLm7W",
  USTGContractAddress: "EQBebHfKXZ6httYnlj5B5c_clQuOhRQeCfbMmy1eYRHJaKTU",
  STTONContractAddress: "EQAv0PrfHU6U621bR3grc0_gtSaTJjyW8jfGHQRYsj6r1aYa",
  TSTONContractAddress: "EQCsP48Vh_3wbAuKzpkdaRwAucVxvL44AHwFAQACN04oBdbH",
  STAKEDContractAddress: "EQCYmsRXZwO2D9y5HUTLqlS0wIKmeiqF-EJOOt7spokgdvxD",
  FTONContractAddress: "EQBTYeIY6zRvra5A26qLhLNV2oLQC2dslzojODcVKHpV-o4w",
};
//WALLET_MNEMONIC like "ggs adads asdp agzxcxz"
const tonStableClient = new TonStableClient(WALLET_MNEMONIC, CONSTANTS);
document.getElementById("getBalance").addEventListener("click", async () => {
  const balance = await tonStableClient.getBalance();
  console.debug("balance", balance);
});
document
  .getElementById("getSingletonState")
  .addEventListener("click", async () => {
    const getSingletonState = await tonStableClient.getSingletonState();
    console.debug("getSingletonState", getSingletonState);
  });
document.getElementById("mint").addEventListener("click", async () => {
  const mint = await tonStableClient.mint();
  console.debug("mint", mint);
  await tonStableClient.waitForTransaction();
});
document
  .getElementById("getAllPositions")
  .addEventListener("click", async () => {
    const list = await tonStableClient.getAllPositions();
    document.getElementById("who").textContent = list[0].owner.toString();
    console.debug("list", list);
  });

document
  .getElementById("tryToLiquidate")
  .addEventListener("click", async () => {
    const list = await tonStableClient.getAllPositions();
    console.debug("list", list);
    await tonStableClient.tryToLiquidate(list[0].owner);
    await tonStableClient.waitForTransaction("tryToLiquidate");
  });
