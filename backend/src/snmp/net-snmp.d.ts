declare module "net-snmp" {
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export enum PduType {
    Trap    = 4,
    GetBulk = 5,
    Inform  = 6,
    Trap2   = 7,
  }

  export enum TrapType {
    ColdStart             = 0,
    WarmStart             = 1,
    LinkDown              = 2,
    LinkUp                = 3,
    AuthenticationFailure = 4,
    EgpNeighborLoss       = 5,
    EnterpriseSpecific    = 6,
  }

  export enum ObjectType {
    Boolean          = 1,
    Integer          = 2,
    OctetString      = 4,
    Null             = 5,
    OID              = 6,
    IpAddress        = 64,
    Counter          = 65,
    Gauge            = 66,
    TimeTicks        = 67,
    Opaque           = 68,
    Counter64        = 70,
    NoSuchObject     = 128,
    NoSuchInstance   = 129,
    EndOfMibView     = 130,
  }

  export interface Varbind {
    oid:   string;
    type:  number;
    value: unknown;
  }

  export interface TrapSession {
    trap(trapType: number, varbinds: Varbind[], callback: (err: Error | null) => void): void;
    close(): void;
  }

  export interface ReceiverOptions {
    port?: number;
    disableAuthorization?: boolean;
    includeAuthentication?: boolean;
  }

  export interface Notification {
    pdu: {
      type:        number;
      varbinds:    Varbind[];
      upTime?:     number;
      enterprise?: string;
      specific?:   number;
      generic?:    number;
    };
    rinfo: { address: string; port: number };
    community: string;
  }

  export function createSession(
    target: string,
    community: string,
    options?: { version?: number; [key: string]: unknown }
  ): TrapSession;

  export function createReceiver(
    options: ReceiverOptions,
    callback: (error: Error | null, notification: Notification) => void
  ): { close(): void };
}
