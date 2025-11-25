import type { BiliDynamicCard } from "../types";

export function removeDuplicateDynamics(
  dynamics: BiliDynamicCard[],
): BiliDynamicCard[] {
  return dynamics.filter(
    (dynamic, index, self) =>
      index === self.findIndex((t) => t.desc.bvid === dynamic.desc.bvid),
  );
}
