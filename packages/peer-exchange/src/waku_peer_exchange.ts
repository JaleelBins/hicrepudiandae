import type { ConnectionManager } from "@libp2p/interface-connection-manager";
import type { PeerStore } from "@libp2p/interface-peer-store";
import { BaseProtocol } from "@waku/core/lib/base_protocol";
import { EnrDecoder } from "@waku/enr";
import type {
  IPeerExchange,
  PeerExchangeQueryParams,
  PeerInfo,
} from "@waku/interfaces";
import { isDefined } from "@waku/utils";
import debug from "debug";
import all from "it-all";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import { Uint8ArrayList } from "uint8arraylist";

import { PeerExchangeRPC } from "./rpc.js";

export const PeerExchangeCodec = "/vac/waku/peer-exchange/2.0.0-alpha1";

const log = debug("waku:peer-exchange");

export interface PeerExchangeComponents {
  peerStore: PeerStore;
  connectionManager: ConnectionManager;
}

/**
 * Implementation of the Peer Exchange protocol (https://rfc.vac.dev/spec/34/)
 */
export class WakuPeerExchange extends BaseProtocol implements IPeerExchange {
  multicodec: string;

  /**
   * @param components - libp2p components
   */
  constructor(public components: PeerExchangeComponents) {
    super(
      PeerExchangeCodec,
      components.peerStore,
      components.connectionManager.getConnections.bind(
        components.connectionManager
      )
    );
    this.multicodec = PeerExchangeCodec;
  }

  /**
   * Make a peer exchange query to a peer
   */
  async query(
    params: PeerExchangeQueryParams
  ): Promise<PeerInfo[] | undefined> {
    const { numPeers } = params;

    const rpcQuery = PeerExchangeRPC.createRequest({
      numPeers: BigInt(numPeers),
    });

    const peer = await this.getPeer(params.peerId);

    const stream = await this.newStream(peer);

    const res = await pipe(
      [rpcQuery.encode()],
      lp.encode(),
      stream,
      lp.decode(),
      async (source) => await all(source)
    );

    try {
      const bytes = new Uint8ArrayList();
      res.forEach((chunk) => {
        bytes.append(chunk);
      });

      const { response } = PeerExchangeRPC.decode(bytes);

      if (!response) {
        log("PeerExchangeRPC message did not contains a `response` field");
        return;
      }

      return Promise.all(
        response.peerInfos
          .map((peerInfo) => peerInfo.enr)
          .filter(isDefined)
          .map(async (enr) => {
            return { ENR: await EnrDecoder.fromRLP(enr) };
          })
      );
    } catch (err) {
      log("Failed to decode push reply", err);
      return;
    }
  }
}

/**
 *
 * @returns A function that creates a new peer exchange protocol
 */
export function wakuPeerExchange(): (
  components: PeerExchangeComponents
) => WakuPeerExchange {
  return (components: PeerExchangeComponents) =>
    new WakuPeerExchange(components);
}
