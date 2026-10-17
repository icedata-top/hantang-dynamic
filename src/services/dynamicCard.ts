import type {
  BiliDynamicCard,
  BiliDynamicItem,
} from "../types/bilibili/dynamic";

const TYPE_CODES: Record<string, number> = {
  DYNAMIC_TYPE_FORWARD: 1,
  DYNAMIC_TYPE_DRAW: 2,
  DYNAMIC_TYPE_WORD: 4,
  DYNAMIC_TYPE_AV: 8,
  DYNAMIC_TYPE_ARTICLE: 64,
};

/** Convert feed content into the card contract used by processing and storage. */
export function toDynamicCard(item: BiliDynamicItem): BiliDynamicCard | null {
  const type = TYPE_CODES[item.type];
  if (!type) return null;
  const author = item.modules.module_author;
  const content = item.modules.module_dynamic;
  const major = content?.major;
  const original = item.orig ? toDynamicCard(item.orig) : null;
  const text = content?.desc?.text || major?.opus?.summary?.text || "";
  const pictures =
    major?.opus?.pics?.map((pic) => ({
      img_src: pic.url,
      img_width: pic.width,
      img_height: pic.height,
    })) ??
    major?.draw?.items.map((pic) => ({
      img_src: pic.src,
      img_width: pic.width,
      img_height: pic.height,
    }));
  const bvid =
    type === 1 ? original?.desc.bvid || "" : major?.archive?.bvid || "";
  return {
    desc: {
      uid: BigInt(author.mid),
      type,
      rid: BigInt(item.basic?.rid_str || major?.archive?.aid || "0"),
      acl: 0,
      view: 0,
      repost: 0,
      comment: 0,
      like: 0,
      is_liked: 0,
      dynamic_id: BigInt(item.id_str),
      dynamic_id_str: item.id_str,
      timestamp: Number(author.pub_ts),
      pre_dy_id: 0n,
      orig_dy_id: BigInt(item.orig?.id_str || "0"),
      orig_dy_id_str: item.orig?.id_str,
      orig_type: BigInt(original?.desc.type || 0),
      user_profile: {
        info: {
          aid: BigInt(author.mid),
          uname: author.name,
          face: author.face || "",
        },
        vip: {},
        pendant: {},
        rank: 0,
        sign: "",
        level_info: {},
      },
      spec_type: 0,
      uid_type: 0,
      stype: 0,
      r_type: 0,
      inner_id: 0n,
      status: 0,
      rid_str: item.basic?.rid_str || "0",
      bvid,
    },
    card: JSON.stringify({
      dynamic: text,
      item: { content: text, description: text, pictures },
      title: major?.article?.title || major?.opus?.title,
      summary: major?.article?.desc || major?.opus?.summary?.text,
      image_urls:
        major?.article?.covers || major?.opus?.pics?.map((pic) => pic.url),
    }),
  };
}
