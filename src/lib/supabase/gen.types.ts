export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      anonymous_sessions: {
        Row: {
          created_at: string;
          data: Json | null;
          expires_at: string | null;
          id: string;
          team_id: string | null;
        };
        Insert: {
          created_at?: string;
          data?: Json | null;
          expires_at?: string | null;
          id: string;
          team_id?: string | null;
        };
        Update: {
          created_at?: string;
          data?: Json | null;
          expires_at?: string | null;
          id?: string;
          team_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "anonymous_sessions_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      audio: {
        Row: {
          created_at: string;
          created_by: string | null;
          duration_ms: number | null;
          file_url: string;
          id: string;
          metadata: Json | null;
          name: string;
          team_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          duration_ms?: number | null;
          file_url: string;
          id?: string;
          metadata?: Json | null;
          name: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          duration_ms?: number | null;
          file_url?: string;
          id?: string;
          metadata?: Json | null;
          name?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audio_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audio_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      characters: {
        Row: {
          config: Json | null;
          created_at: string;
          created_by: string | null;
          id: string;
          lora_url: string | null;
          name: string;
          preview_url: string | null;
          team_id: string;
          updated_at: string;
        };
        Insert: {
          config?: Json | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          lora_url?: string | null;
          name: string;
          preview_url?: string | null;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          config?: Json | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          lora_url?: string | null;
          name?: string;
          preview_url?: string | null;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "characters_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "characters_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      credits: {
        Row: {
          balance: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          balance?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          balance?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "credits_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      frames: {
        Row: {
          created_at: string;
          description: string | null;
          duration_ms: number | null;
          id: string;
          metadata: Json | null;
          order_index: number;
          sequence_id: string;
          thumbnail_url: string | null;
          updated_at: string;
          video_url: string | null;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          duration_ms?: number | null;
          id?: string;
          metadata?: Json | null;
          order_index: number;
          sequence_id: string;
          thumbnail_url?: string | null;
          updated_at?: string;
          video_url?: string | null;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          duration_ms?: number | null;
          id?: string;
          metadata?: Json | null;
          order_index?: number;
          sequence_id?: string;
          thumbnail_url?: string | null;
          updated_at?: string;
          video_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "frames_sequence_id_fkey";
            columns: ["sequence_id"];
            isOneToOne: false;
            referencedRelation: "sequences";
            referencedColumns: ["id"];
          },
        ];
      };
      jobs: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error: string | null;
          id: string;
          payload: Json | null;
          result: Json | null;
          started_at: string | null;
          status: string;
          team_id: string | null;
          type: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          payload?: Json | null;
          result?: Json | null;
          started_at?: string | null;
          status?: string;
          team_id?: string | null;
          type: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          payload?: Json | null;
          result?: Json | null;
          started_at?: string | null;
          status?: string;
          team_id?: string | null;
          type?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "jobs_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sequences: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          metadata: Json | null;
          script: string | null;
          status: Database["public"]["Enums"]["sequence_status"];
          style_id: string | null;
          team_id: string;
          title: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          metadata?: Json | null;
          script?: string | null;
          status?: Database["public"]["Enums"]["sequence_status"];
          style_id?: string | null;
          team_id: string;
          title: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          metadata?: Json | null;
          script?: string | null;
          status?: Database["public"]["Enums"]["sequence_status"];
          style_id?: string | null;
          team_id?: string;
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sequences_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sequences_style_id_fkey";
            columns: ["style_id"];
            isOneToOne: false;
            referencedRelation: "styles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sequences_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sequences_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      style_adaptations: {
        Row: {
          adapted_config: Json;
          created_at: string;
          id: string;
          model_name: string;
          model_provider: string;
          style_id: string;
        };
        Insert: {
          adapted_config?: Json;
          created_at?: string;
          id?: string;
          model_name: string;
          model_provider: string;
          style_id: string;
        };
        Update: {
          adapted_config?: Json;
          created_at?: string;
          id?: string;
          model_name?: string;
          model_provider?: string;
          style_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "style_adaptations_style_id_fkey";
            columns: ["style_id"];
            isOneToOne: false;
            referencedRelation: "styles";
            referencedColumns: ["id"];
          },
        ];
      };
      styles: {
        Row: {
          category: string | null;
          config: Json;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_public: boolean | null;
          is_template: boolean | null;
          name: string;
          parent_id: string | null;
          preview_url: string | null;
          tags: string[] | null;
          team_id: string;
          updated_at: string;
          usage_count: number | null;
          version: number | null;
        };
        Insert: {
          category?: string | null;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_public?: boolean | null;
          is_template?: boolean | null;
          name: string;
          parent_id?: string | null;
          preview_url?: string | null;
          tags?: string[] | null;
          team_id: string;
          updated_at?: string;
          usage_count?: number | null;
          version?: number | null;
        };
        Update: {
          category?: string | null;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_public?: boolean | null;
          is_template?: boolean | null;
          name?: string;
          parent_id?: string | null;
          preview_url?: string | null;
          tags?: string[] | null;
          team_id?: string;
          updated_at?: string;
          usage_count?: number | null;
          version?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "styles_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "styles_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "styles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "styles_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      team_members: {
        Row: {
          joined_at: string;
          role: Database["public"]["Enums"]["team_member_role"];
          team_id: string;
          user_id: string;
        };
        Insert: {
          joined_at?: string;
          role?: Database["public"]["Enums"]["team_member_role"];
          team_id: string;
          user_id: string;
        };
        Update: {
          joined_at?: string;
          role?: Database["public"]["Enums"]["team_member_role"];
          team_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "team_members_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      teams: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          slug: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          slug: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          slug?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      transactions: {
        Row: {
          amount: number;
          balance_after: number;
          created_at: string;
          description: string | null;
          id: string;
          metadata: Json | null;
          type: Database["public"]["Enums"]["transaction_type"];
          user_id: string;
        };
        Insert: {
          amount: number;
          balance_after: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          metadata?: Json | null;
          type: Database["public"]["Enums"]["transaction_type"];
          user_id: string;
        };
        Update: {
          amount?: number;
          balance_after?: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          metadata?: Json | null;
          type?: Database["public"]["Enums"]["transaction_type"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transactions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      user_profiles: {
        Row: {
          anonymous_id: string | null;
          avatar_url: string | null;
          created_at: string;
          full_name: string | null;
          id: string;
          onboarding_completed: boolean | null;
          updated_at: string;
        };
        Insert: {
          anonymous_id?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id: string;
          onboarding_completed?: boolean | null;
          updated_at?: string;
        };
        Update: {
          anonymous_id?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id?: string;
          onboarding_completed?: boolean | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      users: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          full_name: string | null;
          id: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          full_name?: string | null;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      vfx: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          preset_config: Json;
          preview_url: string | null;
          team_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          preset_config?: Json;
          preview_url?: string | null;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          preset_config?: Json;
          preview_url?: string | null;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vfx_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vfx_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      cleanup_expired_anonymous_sessions: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      create_style_version: {
        Args: {
          creator_id: string;
          new_config: Json;
          new_description: string;
          new_name: string;
          original_style_id: string;
        };
        Returns: string;
      };
      gtrgm_compress: {
        Args: { "": unknown };
        Returns: unknown;
      };
      gtrgm_decompress: {
        Args: { "": unknown };
        Returns: unknown;
      };
      gtrgm_in: {
        Args: { "": unknown };
        Returns: unknown;
      };
      gtrgm_options: {
        Args: { "": unknown };
        Returns: undefined;
      };
      gtrgm_out: {
        Args: { "": unknown };
        Returns: unknown;
      };
      increment_style_usage: {
        Args: { style_uuid: string };
        Returns: undefined;
      };
      set_limit: {
        Args: { "": number };
        Returns: number;
      };
      show_limit: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      show_trgm: {
        Args: { "": string };
        Returns: string[];
      };
    };
    Enums: {
      sequence_status:
        | "draft"
        | "processing"
        | "completed"
        | "failed"
        | "archived";
      team_member_role: "owner" | "admin" | "member" | "viewer";
      transaction_type:
        | "credit_purchase"
        | "credit_usage"
        | "credit_refund"
        | "credit_adjustment";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      sequence_status: [
        "draft",
        "processing",
        "completed",
        "failed",
        "archived",
      ],
      team_member_role: ["owner", "admin", "member", "viewer"],
      transaction_type: [
        "credit_purchase",
        "credit_usage",
        "credit_refund",
        "credit_adjustment",
      ],
    },
  },
} as const;
