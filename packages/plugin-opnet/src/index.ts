import { deployContractAction } from "./actions/deploy.ts";
import type { Plugin } from "@elizaos/core";
import { opnetProvider } from "./providers/wallet.ts";

export * from "./actions/deploy.ts";
export * from "./providers/wallet";
export * from "./types";

export const opnetPlugin: Plugin = {
    name: "opnet",
    description: "OP_NET support UTXO blockchain adding smart contract support",
    providers: [opnetProvider], // evmWalletProvider
    evaluators: [],
    services: [],
    actions: [deployContractAction], //transferAction, swapAction
};

export default opnetPlugin;
