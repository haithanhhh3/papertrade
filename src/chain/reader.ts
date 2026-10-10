// Direct HyperEVM reads, used to cross-check the API and for values the API does not expose.

import { createPublicClient, defineChain, http, parseAbi, type Address } from "viem";

export function hyperEvm(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: "HyperEVM",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

const tokenomicsAbi = parseAbi([
  "function trackedLpUsd() view returns (int256)",
  "function tailProgressUsd() view returns (uint256)",
]);
const exchangeAbi = parseAbi([
  "function totalQueued() view returns (uint256)",
  "function sideBucket() view returns (uint256)",
  "function tradingPaused() view returns (bool)",
]);
const stakingAbi = parseAbi(["function pendingReward(address) view returns (uint256)"]);

export class ChainReader {
  private readonly client;

  constructor(
    rpcUrl: string,
    chainId: number,
    private readonly contracts: { exchange: Address; tokenomics: Address; paperStaking: Address },
  ) {
    this.client = createPublicClient({ chain: hyperEvm(chainId, rpcUrl), transport: http(rpcUrl, { timeout: 10_000 }) });
  }

  async protocol(): Promise<{ trackedLp: bigint; tail: bigint; totalQueued: bigint; sideBucket: bigint; tradingPaused: boolean }> {
    const [trackedLp, tail, totalQueued, sideBucket, tradingPaused] = await Promise.all([
      this.client.readContract({ address: this.contracts.tokenomics, abi: tokenomicsAbi, functionName: "trackedLpUsd" }),
      this.client.readContract({ address: this.contracts.tokenomics, abi: tokenomicsAbi, functionName: "tailProgressUsd" }),
      this.client.readContract({ address: this.contracts.exchange, abi: exchangeAbi, functionName: "totalQueued" }),
      this.client.readContract({ address: this.contracts.exchange, abi: exchangeAbi, functionName: "sideBucket" }),
      this.client.readContract({ address: this.contracts.exchange, abi: exchangeAbi, functionName: "tradingPaused" }),
    ]);
    return { trackedLp, tail, totalQueued, sideBucket, tradingPaused };
  }

  /** Distributed, unclaimed USDC rewards (18-decimal internal accounting). */
  async pendingReward(wallet: Address): Promise<bigint> {
    return this.client.readContract({ address: this.contracts.paperStaking, abi: stakingAbi, functionName: "pendingReward", args: [wallet] });
  }
}
