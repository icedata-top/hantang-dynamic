import { fetchNewVideos, fetchHistoricalVideos } from './api';
import { saveToCSV } from './csv';
import { StateManager } from './state';
import { processVideoData, sleep } from './utils';
import config from './config';

const stateManager = new StateManager();

async function fetchVideos(): Promise<void> {
    const videos = [];
    const lastDynamicId = stateManager.getLastDynamicId();
    console.log(`Starting fetch with last dynamic ID: ${lastDynamicId}`);
    
    // Fetch new videos first
    console.log('Fetching new videos...');
    const newVideosResponse = await fetchNewVideos();
    if (newVideosResponse.data.cards?.length) {
        const latestDynamicId = newVideosResponse.data.cards[0].desc.dynamic_id.toString();
        console.log(`Found ${newVideosResponse.data.cards.length} new videos. Latest dynamic ID: ${latestDynamicId}`);
        stateManager.updateLastDynamicId(latestDynamicId);
        videos.push(...await processVideoData(newVideosResponse.data.cards));
    } else {
        console.log('No new videos found');
    }

    // Wait before next request
    await sleep(config.API_WAIT_TIME);

    // Fetch historical videos if needed
    let currentOffset = newVideosResponse.data.next_offset || (newVideosResponse.data.cards?.[newVideosResponse.data.cards.length - 1]?.desc.dynamic_id)?.toString();
    let pageCount = 1;

    console.log('Starting historical video fetch...' + currentOffset);
    while (currentOffset) {
        console.log(`\nFetching page ${pageCount} with offset: ${currentOffset}`);
        const historyResponse = await fetchHistoricalVideos(currentOffset);
        
        if (!historyResponse.data.cards?.length) {
            console.log('No more videos found in history. Stopping.');
            break;
        }
        
        console.log(`Retrieved ${historyResponse.data.cards.length} videos on page ${pageCount}`);
        
        // Check if the oldest video in this batch is too old
        const oldestVideo = historyResponse.data.cards[historyResponse.data.cards.length - 1];
        const oldestPubdate = JSON.parse(oldestVideo.card).pubdate;
        const oldestDate = new Date(oldestPubdate * 1000);
        
        if (!stateManager.isWithinMaxHistory(oldestPubdate)) {
            console.log(`Oldest video (${oldestDate.toISOString()}) is beyond max history days (${config.MAX_HISTORY_DAYS}). Stopping.`);
            break;
        }
        
        videos.push(...await processVideoData(historyResponse.data.cards));
        
        // Check if we've reached our last known video
        const foundLastVideo = historyResponse.data.cards.some(
            card => card.desc.dynamic_id.toString() === lastDynamicId
        );
        if (foundLastVideo) {
            console.log(`Found last known video (dynamic ID: ${lastDynamicId}). Stopping.`);
            break;
        }
    
        currentOffset = historyResponse.data.next_offset;
        if (!currentOffset) {
            console.log('No more pages available. Stopping.');
        }
        
        pageCount++;
        await sleep(config.API_WAIT_TIME);
    }

    // Save to CSV if we have videos
    if (videos.length > 0) {
        const outputPath = `./videos_${Date.now()}.csv`;
        console.log(`Saving ${videos.length} videos to ${outputPath}`);
        saveToCSV(videos, outputPath);
    } else {
        console.log('No videos to save');
    }
}

// Main application function
async function main() {
    console.log('Bilibili Video Tracker started...');

    // Log configuration
    const configString = await readConfig();
    console.log('Configuration:', configString);
    
    // Schedule periodic fetches (15 minutes)
    const interval = config.FETCH_INTERVAL;
    
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