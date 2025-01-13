import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
} from "@elizaos/core";

import { Wallet } from "@btc-vision/transaction";
import { Network, networks } from "@btc-vision/bitcoin";

enum BitcoinNetworks {
    MAINNET = "mainnet",
    TESTNET = "testnet",
    REGTEST = "regtest",
}

function getNetwork(network: BitcoinNetworks): Network {
    switch (network) {
        case BitcoinNetworks.MAINNET:
            return networks.bitcoin;
        case BitcoinNetworks.TESTNET:
            return networks.testnet;
        case BitcoinNetworks.REGTEST:
            return networks.regtest;
        default:
            return networks.bitcoin;
    }
}

export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("OPNET_PRIVATE_KEY") as `0x${string}`;

    if (!privateKey) {
        throw new Error("OPNET_PRIVATE_KEY is missing");
    }

    const network = runtime.getSetting("OPNET_NETWORK") as string;
    const chain = getNetwork(network as BitcoinNetworks);

    return new Wallet(
        {
            address: "",
            privateKey: privateKey,
            publicKey: "",
        },
        chain
    );
};

export const opnetProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        _message: Memory,
        state?: State
    ): Promise<string | null> {
        try {
            const walletProvider = await initWalletProvider(runtime);

            const agentName = state?.agentName || "The agent";
            return `${agentName}'s Bitcoin Wallet Address: ${walletProvider.p2tr}`;
        } catch (error) {
            console.error("Error in Bitcoin wallet provider:", error);
            return null;
        }
    },
};
