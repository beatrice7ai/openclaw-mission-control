/** Remap gateway-reported paths to this container's mount points. */
export function remapGatewayPath(p: string): string {
  const GATEWAY_HOME = process.env.OPENCLAW_GATEWAY_HOME || "/home/node";
  const LOCAL_HOME = process.env.OPENCLAW_HOME || "/openclaw-home";
  const LOCAL_WORKSPACE = process.env.OPENCLAW_WORKSPACE || "/beatrice";
  // /home/node/.openclaw/... -> /openclaw-home/...
  if (p.startsWith(GATEWAY_HOME + "/.openclaw")) {
    return LOCAL_HOME + p.slice((GATEWAY_HOME + "/.openclaw").length);
  }
  // /home/node/beatrice -> /beatrice
  if (p.startsWith(GATEWAY_HOME + "/beatrice")) {
    return LOCAL_WORKSPACE + p.slice((GATEWAY_HOME + "/beatrice").length);
  }
  return p;
}
