export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      card_access_log: {
        Row: {
          accessed_at: string
          actor_id: string | null
          id: number
          submission_id: string
        }
        Insert: {
          accessed_at?: string
          actor_id?: string | null
          id?: number
          submission_id: string
        }
        Update: {
          accessed_at?: string
          actor_id?: string | null
          id?: number
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_access_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_access_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "card_access_log_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "card_access_log_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "card_access_log_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "card_access_log_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      carrier_declines: {
        Row: {
          carrier_id: string
          declined_at: string
          declined_by: string | null
          id: number
          reason: string | null
          submission_id: string
        }
        Insert: {
          carrier_id: string
          declined_at?: string
          declined_by?: string | null
          id?: number
          reason?: string | null
          submission_id: string
        }
        Update: {
          carrier_id?: string
          declined_at?: string
          declined_by?: string | null
          id?: number
          reason?: string | null
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "carrier_declines_carrier_id_fkey"
            columns: ["carrier_id"]
            isOneToOne: false
            referencedRelation: "carrier_decline_stats"
            referencedColumns: ["carrier_id"]
          },
          {
            foreignKeyName: "carrier_declines_carrier_id_fkey"
            columns: ["carrier_id"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "carrier_declines_declined_by_fkey"
            columns: ["declined_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "carrier_declines_declined_by_fkey"
            columns: ["declined_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      carriers: {
        Row: {
          active: boolean
          aliases: string[]
          created_at: string
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          aliases?: string[]
          created_at?: string
          id?: string
          name: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          aliases?: string[]
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      centers: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      cx_lead_status: {
        Row: {
          chargeback_reason: string | null
          chargeback_status_id: string | null
          commission_reason: string | null
          commission_status_id: string | null
          policy_reason: string | null
          policy_status_id: string | null
          premium_reason: string | null
          premium_status_id: string | null
          submission_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          chargeback_reason?: string | null
          chargeback_status_id?: string | null
          commission_reason?: string | null
          commission_status_id?: string | null
          policy_reason?: string | null
          policy_status_id?: string | null
          premium_reason?: string | null
          premium_status_id?: string | null
          submission_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          chargeback_reason?: string | null
          chargeback_status_id?: string | null
          commission_reason?: string | null
          commission_status_id?: string | null
          policy_reason?: string | null
          policy_status_id?: string | null
          premium_reason?: string | null
          premium_status_id?: string | null
          submission_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cx_lead_status_chargeback_status_id_fkey"
            columns: ["chargeback_status_id"]
            isOneToOne: false
            referencedRelation: "cx_status_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_commission_status_id_fkey"
            columns: ["commission_status_id"]
            isOneToOne: false
            referencedRelation: "cx_status_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_policy_status_id_fkey"
            columns: ["policy_status_id"]
            isOneToOne: false
            referencedRelation: "cx_status_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_premium_status_id_fkey"
            columns: ["premium_status_id"]
            isOneToOne: false
            referencedRelation: "cx_status_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_lead_status_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_lead_status_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_lead_status_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_lead_status_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
      cx_status_history: {
        Row: {
          actor_id: string | null
          category: string
          changed_at: string
          from_code: string | null
          id: number
          reason: string | null
          submission_id: string
          to_code: string | null
        }
        Insert: {
          actor_id?: string | null
          category: string
          changed_at?: string
          from_code?: string | null
          id?: number
          reason?: string | null
          submission_id: string
          to_code?: string | null
        }
        Update: {
          actor_id?: string | null
          category?: string
          changed_at?: string
          from_code?: string | null
          id?: number
          reason?: string | null
          submission_id?: string
          to_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cx_status_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cx_status_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "cx_status_history_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_status_history_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_status_history_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "cx_status_history_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      cx_status_options: {
        Row: {
          active: boolean
          category: string
          code: string
          created_at: string
          id: string
          label: string
          sort_order: number
          tone: string
        }
        Insert: {
          active?: boolean
          category: string
          code: string
          created_at?: string
          id?: string
          label: string
          sort_order?: number
          tone?: string
        }
        Update: {
          active?: boolean
          category?: string
          code?: string
          created_at?: string
          id?: string
          label?: string
          sort_order?: number
          tone?: string
        }
        Relationships: []
      }
      cx_tags: {
        Row: {
          active: boolean
          created_at: string
          id: string
          label: string
          sort_order: number
          tone: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          label: string
          sort_order?: number
          tone?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          label?: string
          sort_order?: number
          tone?: string
        }
        Relationships: []
      }
      form_events: {
        Row: {
          actor_id: string | null
          created_at: string
          detail: Json | null
          event_type: string
          id: number
          submission_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type: string
          id?: number
          submission_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type?: string
          id?: number
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "form_events_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "form_events_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "form_events_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "form_events_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_imports: {
        Row: {
          created_at: string
          file_name: string | null
          id: string
          imported_count: number
          row_count: number
          skipped_count: number
          upload_ip: string | null
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          id?: string
          imported_count?: number
          row_count?: number
          skipped_count?: number
          upload_ip?: string | null
          uploaded_by: string
        }
        Update: {
          created_at?: string
          file_name?: string | null
          id?: string
          imported_count?: number
          row_count?: number
          skipped_count?: number
          upload_ip?: string | null
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
      payload_edits: {
        Row: {
          actor_id: string | null
          edited_at: string
          field: string
          id: number
          new_value: string | null
          old_value: string | null
          submission_id: string
        }
        Insert: {
          actor_id?: string | null
          edited_at?: string
          field: string
          id?: number
          new_value?: string | null
          old_value?: string | null
          submission_id: string
        }
        Update: {
          actor_id?: string | null
          edited_at?: string
          field?: string
          id?: number
          new_value?: string | null
          old_value?: string | null
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payload_edits_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payload_edits_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "payload_edits_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payload_edits_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payload_edits_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payload_edits_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_details: {
        Row: {
          account_number: string | null
          account_title: string | null
          bank_name: string | null
          card_exp: string | null
          card_last4: string | null
          card_number: string | null
          card_purged_at: string | null
          created_at: string
          cvv: string | null
          cvv_purged_at: string | null
          payment_type: string
          routing_number: string | null
          submission_id: string
        }
        Insert: {
          account_number?: string | null
          account_title?: string | null
          bank_name?: string | null
          card_exp?: string | null
          card_last4?: string | null
          card_number?: string | null
          card_purged_at?: string | null
          created_at?: string
          cvv?: string | null
          cvv_purged_at?: string | null
          payment_type?: string
          routing_number?: string | null
          submission_id: string
        }
        Update: {
          account_number?: string | null
          account_title?: string | null
          bank_name?: string | null
          card_exp?: string | null
          card_last4?: string | null
          card_number?: string | null
          card_purged_at?: string | null
          created_at?: string
          cvv?: string | null
          cvv_purged_at?: string | null
          payment_type?: string
          routing_number?: string | null
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_details_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payment_details_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payment_details_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "payment_details_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          center_id: string | null
          created_at: string
          full_name: string | null
          id: string
          org_name: string | null
          role: Database["public"]["Enums"]["app_role"]
          staff_id: string | null
        }
        Insert: {
          active?: boolean
          center_id?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          org_name?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          staff_id?: string | null
        }
        Update: {
          active?: boolean
          center_id?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          org_name?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_center_id_fkey"
            columns: ["center_id"]
            isOneToOne: false
            referencedRelation: "centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_center_id_fkey"
            columns: ["center_id"]
            isOneToOne: false
            referencedRelation: "submission_totals_by_center"
            referencedColumns: ["center_id"]
          },
        ]
      }
      settings_audit: {
        Row: {
          actor_id: string | null
          changed_at: string
          id: number
          key: string
          new_value: string | null
          old_value: string | null
        }
        Insert: {
          actor_id?: string | null
          changed_at?: string
          id?: number
          key: string
          new_value?: string | null
          old_value?: string | null
        }
        Update: {
          actor_id?: string | null
          changed_at?: string
          id?: number
          key?: string
          new_value?: string | null
          old_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "settings_audit_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settings_audit_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
      submission_tags: {
        Row: {
          created_at: string
          submission_id: string
          tag_id: string
          tagged_by: string | null
        }
        Insert: {
          created_at?: string
          submission_id: string
          tag_id: string
          tagged_by?: string | null
        }
        Update: {
          created_at?: string
          submission_id?: string
          tag_id?: string
          tagged_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submission_tags_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "submission_tags_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "submission_tags_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "submission_tags_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "cx_tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_tags_tagged_by_fkey"
            columns: ["tagged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_tags_tagged_by_fkey"
            columns: ["tagged_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
      submissions: {
        Row: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        Insert: {
          agent_name?: string | null
          archived_at?: string | null
          archived_by?: string | null
          assigned_at?: string | null
          assigned_to?: string | null
          center_id?: string | null
          center_name?: string | null
          claimed_at?: string | null
          closer_id?: string | null
          created_at?: string
          cx_assigned_at?: string | null
          cx_assigned_to?: string | null
          data_flags?: Json
          disposed_at?: string | null
          disposed_by?: string | null
          disposition?: Database["public"]["Enums"]["disposition_t"] | null
          draft_date?: string | null
          final_carrier_id?: string | null
          future_draft_date?: string | null
          hold_count?: number
          id?: string
          import_id?: string | null
          last_held_at?: string | null
          last_rejected_by?: string | null
          last_timeout_by?: string | null
          payload: Json
          policy_number?: string | null
          rejection_count?: number
          reopened_from_cx_at?: string | null
          source?: string
          source_ref?: string | null
          ssn_normalized?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          submitted_by_role?: Database["public"]["Enums"]["app_role"] | null
          timeout_count?: number
          uploaded_by?: string | null
        }
        Update: {
          agent_name?: string | null
          archived_at?: string | null
          archived_by?: string | null
          assigned_at?: string | null
          assigned_to?: string | null
          center_id?: string | null
          center_name?: string | null
          claimed_at?: string | null
          closer_id?: string | null
          created_at?: string
          cx_assigned_at?: string | null
          cx_assigned_to?: string | null
          data_flags?: Json
          disposed_at?: string | null
          disposed_by?: string | null
          disposition?: Database["public"]["Enums"]["disposition_t"] | null
          draft_date?: string | null
          final_carrier_id?: string | null
          future_draft_date?: string | null
          hold_count?: number
          id?: string
          import_id?: string | null
          last_held_at?: string | null
          last_rejected_by?: string | null
          last_timeout_by?: string | null
          payload?: Json
          policy_number?: string | null
          rejection_count?: number
          reopened_from_cx_at?: string | null
          source?: string
          source_ref?: string | null
          ssn_normalized?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          submitted_by_role?: Database["public"]["Enums"]["app_role"] | null
          timeout_count?: number
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submissions_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_center_id_fkey"
            columns: ["center_id"]
            isOneToOne: false
            referencedRelation: "centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_center_id_fkey"
            columns: ["center_id"]
            isOneToOne: false
            referencedRelation: "submission_totals_by_center"
            referencedColumns: ["center_id"]
          },
          {
            foreignKeyName: "submissions_closer_id_fkey"
            columns: ["closer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_closer_id_fkey"
            columns: ["closer_id"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_cx_assigned_to_fkey"
            columns: ["cx_assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_cx_assigned_to_fkey"
            columns: ["cx_assigned_to"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_disposed_by_fkey"
            columns: ["disposed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_disposed_by_fkey"
            columns: ["disposed_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_final_carrier_id_fkey"
            columns: ["final_carrier_id"]
            isOneToOne: false
            referencedRelation: "carrier_decline_stats"
            referencedColumns: ["carrier_id"]
          },
          {
            foreignKeyName: "submissions_final_carrier_id_fkey"
            columns: ["final_carrier_id"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "lead_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "pending_import_batches"
            referencedColumns: ["import_id"]
          },
          {
            foreignKeyName: "submissions_last_rejected_by_fkey"
            columns: ["last_rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_last_rejected_by_fkey"
            columns: ["last_rejected_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_last_timeout_by_fkey"
            columns: ["last_timeout_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_last_timeout_by_fkey"
            columns: ["last_timeout_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
          {
            foreignKeyName: "submissions_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
    }
    Views: {
      carrier_decline_stats: {
        Row: {
          carrier_id: string | null
          carrier_name: string | null
          last_decline: string | null
          leads_declined: number | null
          total_declines: number | null
        }
        Relationships: []
      }
      closer_lead_alerts: {
        Row: {
          carrier: string | null
          category: string | null
          changed_at: string | null
          customer_name: string | null
          status_label: string | null
          submission_id: string | null
          submitted_at: string | null
          tone: string | null
        }
        Relationships: []
      }
      cx_pipeline: {
        Row: {
          approved_on: string | null
          chargeback_code: string | null
          chargeback_label: string | null
          chargeback_reason: string | null
          chargeback_tone: string | null
          commission_code: string | null
          commission_label: string | null
          commission_reason: string | null
          commission_tone: string | null
          cx_updated_at: string | null
          cx_updated_by: string | null
          draft_date: string | null
          payload: Json | null
          policy_code: string | null
          policy_label: string | null
          policy_reason: string | null
          policy_tone: string | null
          premium_code: string | null
          premium_label: string | null
          premium_reason: string | null
          premium_tone: string | null
          source: string | null
          submission_id: string | null
          submitted_on: string | null
        }
        Relationships: []
      }
      cx_status_summary: {
        Row: {
          category: string | null
          code: string | null
          label: string | null
          lead_count: number | null
          sort_order: number | null
          tone: string | null
        }
        Relationships: []
      }
      cx_untouched: {
        Row: {
          disposed_at: string | null
          payload: Json | null
          submission_id: string | null
        }
        Relationships: []
      }
      pending_import_batches: {
        Row: {
          created_at: string | null
          file_name: string | null
          flagged_count: number | null
          import_id: string | null
          lead_count: number | null
          row_count: number | null
          uploaded_by: string | null
          uploader_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "validator_stats"
            referencedColumns: ["validator_id"]
          },
        ]
      }
      submission_declined_carriers: {
        Row: {
          decline_count: number | null
          declined_carriers: string[] | null
          last_declined_at: string | null
          submission_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "closer_lead_alerts"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_pipeline"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "cx_untouched"
            referencedColumns: ["submission_id"]
          },
          {
            foreignKeyName: "carrier_declines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_totals: {
        Row: {
          approved: number | null
          awaiting_manager: number | null
          closer_submissions: number | null
          declined: number | null
          in_review: number | null
          offline_submissions: number | null
          pending: number | null
          rejections: number | null
          timeouts: number | null
          validator_submissions: number | null
        }
        Relationships: []
      }
      submission_totals_by_center: {
        Row: {
          approved: number | null
          awaiting_manager: number | null
          center_id: string | null
          center_name: string | null
          declined: number | null
          pending: number | null
          sort_order: number | null
          total_submissions: number | null
        }
        Relationships: []
      }
      validator_stats: {
        Row: {
          approved: number | null
          assigned: number | null
          declined: number | null
          holds: number | null
          pending: number | null
          rejected: number | null
          staff_id: string | null
          timed_out: number | null
          validator_id: string | null
          validator_name: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_submission_tag: {
        Args: { p_sub: string; p_tag: string }
        Returns: undefined
      }
      admin_settings: { Args: never; Returns: Json }
      approve_import_batch: {
        Args: { p_import_id: string; p_reject_ids?: string[] }
        Returns: Json
      }
      archive_submission: {
        Args: { p_reason?: string; p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assign_to_validator: {
        Args: { p_sub: string; p_validator: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bump_import_skipped: {
        Args: { p_count: number; p_import_id: string }
        Returns: undefined
      }
      card_details: { Args: { p_sub: string }; Returns: Json }
      check_duplicate_ssn: { Args: { p_ssn: string }; Returns: Json }
      claim_submission: {
        Args: { p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      clear_data_flag: {
        Args: { p_field: string; p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_with_carriers: {
        Args: { p_carrier_ids: string[]; p_reason?: string; p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dispose_submission: {
        Args: {
          p_disposition: Database["public"]["Enums"]["disposition_t"]
          p_sub: string
        }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      expire_stale_reviews: { Args: never; Returns: number }
      hold_submission: {
        Args: { p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ingest_sheet_lead: {
        Args: {
          p_flags?: Json
          p_import_id?: string
          p_payload: Json
          p_payment?: Json
          p_source_ref: string
          p_uploaded_by?: string
        }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      move_to_validation: {
        Args: { p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      my_forwarded_leads: {
        Args: never
        Returns: {
          created_at: string
          disposed_at: string
          disposition: Database["public"]["Enums"]["disposition_t"]
          hold_count: number
          id: string
          payload: Json
          rejection_count: number
          status: Database["public"]["Enums"]["sub_status"]
          timeout_count: number
        }[]
      }
      my_role: { Args: never; Returns: Database["public"]["Enums"]["app_role"] }
      payment_summary: { Args: { p_sub: string }; Returns: Json }
      purge_old_reporting_leads: { Args: never; Returns: number }
      purge_payment_data: { Args: never; Returns: Json }
      reject_assignment: {
        Args: { p_reason?: string; p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_import_batch: {
        Args: { p_import_id: string; p_reason?: string }
        Returns: Json
      }
      remove_submission_tag: {
        Args: { p_sub: string; p_tag: string }
        Returns: undefined
      }
      reporting_retention_status: { Args: never; Returns: Json }
      reporting_since: { Args: { p_days: number }; Returns: string }
      resolve_carrier: {
        Args: { p_input: string }
        Returns: {
          active: boolean
          aliases: string[]
          created_at: string
          id: string
          name: string
          sort_order: number
        }
        SetofOptions: {
          from: "*"
          to: "carriers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      review_settings: { Args: never; Returns: Json }
      review_window: { Args: never; Returns: string }
      set_admin_setting: {
        Args: { p_key: string; p_value: string }
        Returns: Json
      }
      set_cx_status: {
        Args: {
          p_category: string
          p_option_id: string
          p_reason?: string
          p_sub: string
        }
        Returns: Json
      }
      set_validator_fields: {
        Args: {
          p_agent_name: string
          p_final_carrier_id: string
          p_policy_number: string
          p_sub: string
        }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_lead_import: {
        Args: { p_file_name: string; p_row_count: number }
        Returns: {
          created_at: string
          file_name: string | null
          id: string
          imported_count: number
          row_count: number
          skipped_count: number
          upload_ip: string | null
          uploaded_by: string
        }
        SetofOptions: {
          from: "*"
          to: "lead_imports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submission_totals_by_center_range: {
        Args: { p_days?: number }
        Returns: {
          approved: number
          awaiting_manager: number
          center_id: string
          center_name: string
          declined: number
          pending: number
          sort_order: number
          total_submissions: number
        }[]
      }
      submission_totals_range: {
        Args: { p_days?: number }
        Returns: {
          approved: number
          awaiting_manager: number
          closer_submissions: number
          declined: number
          in_review: number
          offline_submissions: number
          pending: number
          rejections: number
          timeouts: number
          validator_submissions: number
        }[]
      }
      submit_form: {
        Args: { p_payload: Json }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submit_form_parked: {
        Args: { p_payload: Json }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      unarchive_submission: {
        Args: { p_sub: string }
        Returns: {
          agent_name: string | null
          archived_at: string | null
          archived_by: string | null
          assigned_at: string | null
          assigned_to: string | null
          center_id: string | null
          center_name: string | null
          claimed_at: string | null
          closer_id: string | null
          created_at: string
          cx_assigned_at: string | null
          cx_assigned_to: string | null
          data_flags: Json
          disposed_at: string | null
          disposed_by: string | null
          disposition: Database["public"]["Enums"]["disposition_t"] | null
          draft_date: string | null
          final_carrier_id: string | null
          future_draft_date: string | null
          hold_count: number
          id: string
          import_id: string | null
          last_held_at: string | null
          last_rejected_by: string | null
          last_timeout_by: string | null
          payload: Json
          policy_number: string | null
          rejection_count: number
          reopened_from_cx_at: string | null
          source: string
          source_ref: string | null
          ssn_normalized: string | null
          status: Database["public"]["Enums"]["sub_status"]
          submitted_by_role: Database["public"]["Enums"]["app_role"] | null
          timeout_count: number
          uploaded_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_payload_field: {
        Args: { p_field: string; p_sub: string; p_value: string }
        Returns: Json
      }
      update_payment_field: {
        Args: { p_field: string; p_sub: string; p_value: string }
        Returns: Json
      }
      validator_stats_range: {
        Args: { p_days?: number }
        Returns: {
          approved: number
          assigned: number
          declined: number
          holds: number
          pending: number
          rejected: number
          staff_id: string
          timed_out: number
          validator_id: string
          validator_name: string
        }[]
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "closer"
        | "manager"
        | "validator"
        | "data_uploader"
        | "cxm"
        | "cxa"
        | "closing_manager"
        | "general_manager"
      disposition_t: "accepted" | "declined" | "pending"
      sub_status:
        | "pending_manager"
        | "assigned"
        | "in_review"
        | "returned_timeout"
        | "closed"
        | "pending_import_approval"
        | "parked"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: [
        "admin",
        "closer",
        "manager",
        "validator",
        "data_uploader",
        "cxm",
        "cxa",
        "closing_manager",
        "general_manager",
      ],
      disposition_t: ["accepted", "declined", "pending"],
      sub_status: [
        "pending_manager",
        "assigned",
        "in_review",
        "returned_timeout",
        "closed",
        "pending_import_approval",
        "parked",
      ],
    },
  },
} as const
