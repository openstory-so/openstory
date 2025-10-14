export interface Scene {
  scriptContent: string;
  description?: string;
  duration?: number;
  type?: string;
  intensity?: number;
  orderIndex: number;
  characters?: string[];
  settings?: string[];
}

export interface ProcessSceneJobParams {
  sequenceId: string;
  userId: string;
  teamId: string;
  scene: Scene;
  aiProvider?: "openai" | "anthropic" | "openrouter";
  aiModel?: string;
  imageSize?: string;
  generateThumbnails?: boolean;
}
