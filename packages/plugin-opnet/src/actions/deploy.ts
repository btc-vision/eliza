import {
    Action,
    elizaLogger,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";
import { getParamsWithLLM } from "../utils/utils.ts";
import fs from "fs";
import { BitcoinUtils, JSONRpcProvider } from "opnet";
import path from "path";
import { networks } from "@btc-vision/bitcoin";
import {
    Address,
    AddressVerificator,
    IDeploymentParameters,
    TransactionFactory,
} from "@btc-vision/transaction";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { initWalletProvider } from "../providers/wallet.ts";

const transactionFactory = new TransactionFactory();
const provider = new JSONRpcProvider(
    "https://regtest.opnet.org",
    networks.regtest
);

const deployContractTemplate = `
# Task: Determine the contract code file path and constructor arguments for deploying a contract.

# Instructions: The user is requesting to deploy a contract to the GenLayer protocol.

<latest user message>
{{userMessage}}
</latest user message>

<data from recent messages>
{{recentMessagesData}}
</data from recent messages>

# Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "code_file": "<Contract Code File Path>",
  "args": [<Constructor Args>],
  "leaderOnly": <true/false>
}
\`\`\`
`;

// Convert `import.meta.dirname` to an absolute path string
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compiles the given AssemblyScript source code by overwriting "MyToken.ts"
 * inside "../token" (an AssemblyScript project), spawning the `asc` command.
 * Returns the compiled { wasm, wat } on success.
 */
export async function compileInMemory(
    source: string
): Promise<{ wasm: Buffer }> {
    // 1. Identify your AssemblyScript project directory
    const tokenDir = path.join(__dirname, "../token");

    // 2. Write the source to `MyToken.ts` inside the token project
    const sourceFilePath = path.join(tokenDir + "/src/contracts", "MyToken.ts");
    fs.writeFileSync(sourceFilePath, source);

    // 3. Prepare output filenames in that same directory
    const wasmFilePath = path.join(tokenDir + "/build", "MyToken.wasm");

    console.log("WASM file path:", wasmFilePath);

    // 5. Run `asc` within the `../token` directory
    await new Promise<void>((resolve, reject) => {
        try {
            const ascProcess = spawn(
                "asc",
                "src/index.ts --target release --measure --uncheckedBehavior never".split(
                    " "
                ),
                { cwd: tokenDir }
            );

            let stderr = "";
            ascProcess.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });

            ascProcess.on("close", (code) => {
                if (code !== 0) {
                    reject(
                        new Error(
                            `AssemblyScript compilation failed with exit code ${code}:\n${stderr}`
                        )
                    );
                } else {
                    resolve();
                }
            });
        } catch (e) {
            reject(e);
        }
    });

    // 6. Read the compiled `.wasm` and `.wat`
    const wasmBuffer = fs.readFileSync(wasmFilePath);

    // Return them in memory
    return {
        wasm: wasmBuffer,
    };
}

let locked: boolean = false;

export const deployContractAction: Action = {
    name: "DEPLOY_CONTRACT",
    similes: ["DEPLOY_CONTRACT"],
    description: "Deploy a contract on Bitcoin",
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("OPNET_PRIVATE_KEY");
        return typeof privateKey === "string";
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: unknown,
        callback: HandlerCallback
    ) => {
        if (locked) {
            elizaLogger.error("Deploy contract action is locked");
            throw new Error("Deploy contract action is locked");
        }

        elizaLogger.info("Starting deploy contract action");
        elizaLogger.debug("User message:", message.content.text);

        // Step 1: get your constructor arguments using LLM
        const aOptions = await getParamsWithLLM<{
            args: [string, string, string, string, string];
        }>(runtime, message, deployContractTemplate, state);

        if (!aOptions) {
            elizaLogger.error("Failed to parse deploy contract parameters");
            throw new Error("Failed to parse deploy contract parameters");
        }

        const options = aOptions.args;
        console.log("Deploying contract...", options);

        if (
            !AddressVerificator.isValidPublicKey(options[4], networks.regtest)
        ) {
            elizaLogger.error("Invalid mint address");
            throw new Error("Invalid mint address");
        }

        let result: string = "";

        // Path to your TypeScript-based AssemblyScript file
        const p = path.join(
            import.meta.dirname,
            "../token/src/contracts/MyToken.ts"
        );

        // Read the original contract file
        const originalFile = fs.readFileSync(p).toString();

        // Step 2: Replace placeholders
        try {
            locked = true;

            const realSupply = BitcoinUtils.expandToDecimals(
                options[2],
                options[3]
            );

            const pubKey = Address.fromString(options[4]);
            const pubKeyToArray = Array.from(pubKey);

            const modifiedFile = originalFile
                .replace("{{NAME}}", options[0])
                .replace("{{SYMBOL}}", options[1])
                .replace("{{SUPPLY}}", realSupply.toString())
                .replace("{{DECIMALS}}", options[3])
                .replace("{{MINT_ADDRESS}}", `${pubKeyToArray}`);

            console.log(
                `Contract code ready for in-memory compilation. ${pubKeyToArray}`
            );

            // Step 3: Compile in memory
            const { wasm } = await compileInMemory(modifiedFile);

            fs.writeFileSync(p, originalFile);

            console.log("WASM byte length:", wasm.byteLength);

            const wallet = await initWalletProvider(runtime);

            const signer = wallet.keypair;
            const utxos = await provider.utxoManager.getUTXOsForAmount({
                address: wallet.p2tr,
                amount: 100_000n,
                mergePendingUTXOs: true,
            });

            const deployData: IDeploymentParameters = {
                gasSatFee: 1_500n,
                calldata: Buffer.alloc(0),
                feeRate: 10,
                bytecode: Buffer.from(wasm.buffer),
                from: wallet.p2tr,
                signer: signer,
                priorityFee: 0n,
                utxos: utxos,
                network: networks.regtest,
            };

            // Step 4: Deploy the contract
            const tx = await transactionFactory.signDeployment(deployData);
            console.log("Transaction ready for broadcast:", tx);

            const tx1 = await provider.sendRawTransaction(
                tx.transaction[0],
                false
            );
            console.log("Transaction sent:", tx1);

            const tx2 = await provider.sendRawTransaction(
                tx.transaction[1],
                false
            );
            console.log("Transaction sent:", tx2);

            if (tx2.success) {
                result = `Deployed at ${tx.contractPubKey} boss.\n\nhttps://mempool.opnet.org/tx/${tx2.result}`;
            } else {
                result = `:( something went wrong boss.`;
            }
        } catch (e) {
            fs.writeFileSync(p, originalFile);

            console.log(e);
            elizaLogger.error("Failed to compile contract in memory", e);
            throw new Error("Failed to compile contract in memory");
        } finally {
            locked = false;
        }

        elizaLogger.success(
            `Successfully sent contract for deployment. Transaction hash: ${result}`
        );
        await callback(
            {
                text: `Successfully sent contract for deployment. Transaction hash: ${result}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy a token for me",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Sure! I'll help you deploy a token. Please provide the code file path and constructor arguments.",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "The token name is [TOKEN] and the symbol is [SYM], max supply is [SUPPLY], decimals is [DECIMALS], and mint the supply to address [ADDRESS].",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Understood, I'll help you deploy the token with the name [TOKEN] and symbol [SYM]. Please wait a moment.",
                    action: "DEPLOY_CONTRACT",
                },
            },
        ],
    ],
};
