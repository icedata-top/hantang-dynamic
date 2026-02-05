const XOR_CODE = 23442827791579n;
const MASK_CODE = 2251799813685247n;
const MAX_AID = 1n << 51n;
const BASE = 58n;

const TABLE = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";

export function bv2av(bvid: string): number {
  const arr = Array.from(bvid);
  [arr[3], arr[9]] = [arr[9], arr[3]];
  [arr[4], arr[7]] = [arr[7], arr[4]];
  arr.splice(0, 3);
  const tmp = arr.reduce(
    (pre, ch) => pre * BASE + BigInt(TABLE.indexOf(ch)),
    0n,
  );
  return Number((tmp & MASK_CODE) ^ XOR_CODE);
}

export function av2bv(aid: number): string {
  const bytes = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
  let bvIndex = bytes.length - 1;
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
  while (tmp > 0n) {
    bytes[bvIndex] = TABLE[Number(tmp % BASE)];
    tmp = tmp / BASE;
    bvIndex -= 1;
  }
  [bytes[3], bytes[9]] = [bytes[9], bytes[3]];
  [bytes[4], bytes[7]] = [bytes[7], bytes[4]];
  return bytes.join("");
}
