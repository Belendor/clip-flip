export interface Tag {
    id?: number;
    title: string;
    videoCount?: number;
}

export interface Model {
    id?: number;
    name?: string;
}

export type ReactionType = "like" | "dislike";

export interface Video {
    id: number;
    title?: string | null;
    studio?: string | null;
    seriesNr?: number | null;
    seriesTotal?: number | null;
    reactions?: { userId: number; count: number }[];
    likes?: number;
    dislikes?: number;
    myReaction?: ReactionType | null;
}

export interface VideoWithRelations extends Video {
    tags?: Tag[];
    models?: Model[];
}

export interface UpdateVideoPayload {
    id: string;
    title?: string | string[];
    models?: string | string[];
    studio?: string | string[];
    tag?: {
        id?: number;
        title: string | string[];
    };
}

export interface NewVideo {
    id: number;
    title?: string | null;
    studio?: string | null;
    seriesNr?: number | null;
    seriesTotal?: number | null;
    tag?: {
        id?: number;
        title: string | string[];
    };
}
