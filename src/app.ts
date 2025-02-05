import { fetchNewVideos, fetchHistoricalVideos } from './api';
import { saveToCSV } from './csv';
import { StateManager } from './state';
import { sleep } from './utils';

const stateManager = new StateManager();

async function processVideoData(cards: any[]): Promise<any[]> {
    return cards.map(card => {
        const cardData = JSON.parse(card.card);
        return {
            aid: cardData.aid,
            bvid: card.desc.bvid,
            pubdate: cardData.pubdate,
            title: cardData.title,
            description: cardData.desc,
            tag: cardData.tname,
            pic: cardData.pic,
            type_id: cardData.tid,
            user_id: card.desc.uid
        };
    });
}

async function fetchVideos(): Promise<void> {
    const videos = [];
    const lastDynamicId = stateManager.getLastDynamicId();
    
    // Fetch new videos first
    const newVideosResponse = await fetchNewVideos();
    if (newVideosResponse.data.cards?.length) {
        const latestDynamicId = newVideosResponse.data.cards[0].desc.dynamic_id.toString();
        stateManager.updateLastDynamicId(latestDynamicId);
        videos.push(...await processVideoData(newVideosResponse.data.cards));
    }

    // Wait before next request
    await sleep(2000);

    // Fetch historical videos if needed
    let currentOffset = newVideosResponse.data.next_offset;
    while (currentOffset && stateManager.isWithinSevenDays()) {
        const historyResponse = await fetchHistoricalVideos(currentOffset);
        if (!historyResponse.data.cards?.length) break;
        
        videos.push(...await processVideoData(historyResponse.data.cards));
        // Check if we've reached our last known video
        const foundLastVideo = historyResponse.data.cards.some(
            card => card.desc.dynamic_id.toString() === lastDynamicId
        );
        if (foundLastVideo) break;

        currentOffset = historyResponse.data.next_offset;
        await sleep(2000);
    }

    // Save to CSV if we have videos
    if (videos.length > 0) {
        saveToCSV(videos, `./videos_${Date.now()}.csv`);
    }
}

// Main application function
async function main() {
    console.log('Bilibili Video Tracker started...');
    
    // Schedule periodic fetches (15 minutes)
    const interval = 15 * 60 * 1000;
    
    // Initial fetch
    await fetchVideos();
    
    // Schedule subsequent fetches
    const scheduler = setInterval(async () => {
        try {
            await fetchVideos();
        } catch (error) {
            console.error('Error fetching videos:', error);
        }
    }, interval);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        clearInterval(scheduler);
        process.exit(0);
    });
}

main().catch(error => {
    console.error('Error starting application:', error);
    process.exit(1);
});