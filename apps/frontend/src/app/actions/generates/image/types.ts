export interface GeneratedImageStatusResponse {
  team_id: string;
  user_id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  created_at: string;
  updated_at: string;
}
