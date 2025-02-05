import { fetchVideoTags } from './api';
import { VideoTagResponse } from './api';
import config from './config';

export async function processVideoData(cards: any[]): Promise<any[]> {
    const processedVideos = [];
    
    for (const card of cards) {
        const cardData = JSON.parse(card.card);
        
        let tags: string[] = [];
        try {
            const tagResponse: VideoTagResponse = await fetchVideoTags(card.desc.bvid);
            if (tagResponse.data) {
                tags = tagResponse.data.map(tag => tag.tag_name);
            }
            await sleep(config.API_WAIT_TIME);
        } catch (error) {
            console.error(`Failed to fetch tags for ${card.desc.bvid}:`, error);
        }

        processedVideos.push({
            aid: cardData.aid,
            bvid: card.desc.bvid,
            pubdate: cardData.pubdate,
            title: cardData.title,
            description: cardData.desc,
            tag: cardData.tname,
            tags: tags,
            pic: cardData.pic,
            type_id: cardData.tid,
            user_id: card.desc.uid
        });
    }
    
    return processedVideos;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}