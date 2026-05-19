export interface Agent {
    id: string;
    name: string;
    tool_type: string;
    archived: number;
    last_active: string | null;
    created: string;
}
export interface AgentStats {
    id: string;
    digest_count: number;
    recall_count: number;
    prepare_count: number;
}
