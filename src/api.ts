import axios from 'axios';
import config from './config';

const BASE_URL = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr';

interface BiliCard {
    desc: {
        uid: number;
        dynamic_id: number;
        timestamp: number;
        bvid: string;
    };
    card: string; // JSON string containing video details
}

interface BiliResponse {
    code: number;
    msg: string;
    data: {
        cards?: BiliCard[];
        has_more?: number;
        next_offset?: string;
        max_dynamic_id?: number;
    };
}

interface ApiError extends Error {
    response?: {
        status: number;
        data: any;
    };
}

export interface VideoTagResponse {
    code: number;
    message: string;
    ttl: number;
    data: VideoTag[];
}

export interface VideoTag {
    tag_id: number;
    tag_name: string;
    cover: string;
    head_cover: string;
    content: string;
    short_content: string;
    type: number;
    state: number;
    ctime: number;
    count: {
        view: number;
        use: number;
        atten: number;
    };
    is_atten: number;
    likes: number;
    hates: number;
    attribute: number;
    liked: number;
    hated: number;
}

export async function fetchNewVideos(): Promise<BiliResponse> {
    const url = `${BASE_URL}/dynamic_new`;
    const params = {
        uid: config.UID,
        type: 8,
    };
    const headers = {
        Referer: `https://space.bilibili.com/${config.UID}/`,
        Cookie: `SESSDATA=${config.SESSDATA}`,
    };

    try {
        const response = await axios.get<BiliResponse>(url, { params, headers });
        if (response.data.code !== 0) {
            throw new Error(`API Error: ${response.data.msg}`);
        }
        return response.data;
    } catch (error) {
        const apiError = error as ApiError;
        if (apiError.response) {
            throw new Error(`API Error ${apiError.response.status}: ${JSON.stringify(apiError.response.data)}`);
        }
        throw error;
    }
}

export async function fetchHistoricalVideos(offsetDynamicId: string): Promise<BiliResponse> {
    const url = `${BASE_URL}/dynamic_history`;
    const params = {
        uid: config.UID,
        type: 8,
        offset_dynamic_id: offsetDynamicId,
    };
    const headers = {
        Referer: `https://space.bilibili.com/${config.UID}/`,
        Cookie: `SESSDATA=${config.SESSDATA}`,
    };

    try {
        const response = await axios.get<BiliResponse>(url, { params, headers });
        if (response.data.code !== 0) {
            throw new Error(`API Error: ${response.data.msg}`);
        }
        return response.data;
    } catch (error) {
        const apiError = error as ApiError;
        if (apiError.response) {
            throw new Error(`API Error ${apiError.response.status}: ${JSON.stringify(apiError.response.data)}`);
        }
        throw error;
    }
}

export async function fetchVideoTags(bvid: string): Promise<VideoTagResponse> {
    const url = `https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`;
    const response = await fetch(url, {
        headers: {
            'Cookie': `SESSDATA=${config.SESSDATA}`
        }
    });
    return await response.json();
}