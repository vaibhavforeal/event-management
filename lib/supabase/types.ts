export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
      bookings: {
        Row: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          attendee_id: string
          attendee_name?: string | null
          attendee_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          commission_paise?: number
          confirmed_at?: string | null
          convenience_fee_paise?: number
          created_at?: string
          event_id: string
          hold_expires_at?: string | null
          id?: string
          payment_mode?: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          attendee_id?: string
          attendee_name?: string | null
          attendee_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          commission_paise?: number
          confirmed_at?: string | null
          convenience_fee_paise?: number
          created_at?: string
          event_id?: string
          hold_expires_at?: string | null
          id?: string
          payment_mode?: Database["public"]["Enums"]["payment_mode"]
          quantity?: number
          reference?: string
          status?: Database["public"]["Enums"]["booking_status"]
          subtotal_paise?: number
          ticket_type_id?: string
          total_paise?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_attendee_id_fkey"
            columns: ["attendee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_ticket_type_id_fkey"
            columns: ["ticket_type_id"]
            isOneToOne: false
            referencedRelation: "ticket_types"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          allows_cash: boolean
          category: string | null
          city: string
          cover_image_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          has_waitlist: boolean
          hide_venue_until_approved: boolean
          host_id: string
          id: string
          published_at: string | null
          refund_cutoff_hours: number
          requires_approval: boolean
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at: string
          venue_address: string | null
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string | null
        }
        Insert: {
          allows_cash?: boolean
          category?: string | null
          city: string
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          has_waitlist?: boolean
          hide_venue_until_approved?: boolean
          host_id: string
          id?: string
          published_at?: string | null
          refund_cutoff_hours?: number
          requires_approval?: boolean
          slug: string
          starts_at: string
          status?: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at?: string
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string | null
        }
        Update: {
          allows_cash?: boolean
          category?: string | null
          city?: string
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          has_waitlist?: boolean
          hide_venue_until_approved?: boolean
          host_id?: string
          id?: string
          published_at?: string | null
          refund_cutoff_hours?: number
          requires_approval?: boolean
          slug?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["event_status"]
          title?: string
          updated_at?: string
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      fee_rules: {
        Row: {
          commission_bps: number
          convenience_fee_bps: number
          convenience_fee_max_paise: number | null
          convenience_fee_min_paise: number
          created_at: string
          effective_from: string
          host_id: string | null
          id: string
        }
        Insert: {
          commission_bps?: number
          convenience_fee_bps?: number
          convenience_fee_max_paise?: number | null
          convenience_fee_min_paise?: number
          created_at?: string
          effective_from?: string
          host_id?: string | null
          id?: string
        }
        Update: {
          commission_bps?: number
          convenience_fee_bps?: number
          convenience_fee_max_paise?: number | null
          convenience_fee_min_paise?: number
          created_at?: string
          effective_from?: string
          host_id?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fee_rules_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      hosts: {
        Row: {
          avatar_url: string | null
          bank_account_ref: string | null
          bio: string | null
          commission_bps: number
          created_at: string
          display_name: string
          id: string
          kyc_status: Database["public"]["Enums"]["host_kyc_status"]
          profile_id: string
          updated_at: string
          upi_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          bank_account_ref?: string | null
          bio?: string | null
          commission_bps?: number
          created_at?: string
          display_name: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["host_kyc_status"]
          profile_id: string
          updated_at?: string
          upi_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          bank_account_ref?: string | null
          bio?: string | null
          commission_bps?: number
          created_at?: string
          display_name?: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["host_kyc_status"]
          profile_id?: string
          updated_at?: string
          upi_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hosts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      message_log: {
        Row: {
          attempts: number
          booking_id: string | null
          cost_paise: number | null
          created_at: string
          dedupe_key: string
          error: string | null
          id: string
          provider: string | null
          provider_message_id: string | null
          recipient_phone: string
          status: string
          template: string
          updated_at: string
          variables: Json
        }
        Insert: {
          attempts?: number
          booking_id?: string | null
          cost_paise?: number | null
          created_at?: string
          dedupe_key: string
          error?: string | null
          id?: string
          provider?: string | null
          provider_message_id?: string | null
          recipient_phone: string
          status?: string
          template: string
          updated_at?: string
          variables?: Json
        }
        Update: {
          attempts?: number
          booking_id?: string | null
          cost_paise?: number | null
          created_at?: string
          dedupe_key?: string
          error?: string | null
          id?: string
          provider?: string | null
          provider_message_id?: string | null
          recipient_phone?: string
          status?: string
          template?: string
          updated_at?: string
          variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "message_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_paise: number
          booking_id: string
          created_at: string
          error_code: string | null
          error_description: string | null
          id: string
          method: string | null
          provider: string
          provider_order_id: string
          provider_payment_id: string | null
          raw_payload: Json | null
          status: Database["public"]["Enums"]["payment_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          booking_id: string
          created_at?: string
          error_code?: string | null
          error_description?: string | null
          id?: string
          method?: string | null
          provider?: string
          provider_order_id: string
          provider_payment_id?: string | null
          raw_payload?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          booking_id?: string
          created_at?: string
          error_code?: string | null
          error_description?: string | null
          id?: string
          method?: string | null
          provider?: string
          provider_order_id?: string
          provider_payment_id?: string | null
          raw_payload?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      payouts: {
        Row: {
          commission_paise: number
          created_at: string
          event_id: string
          gross_paise: number
          host_id: string
          id: string
          net_paise: number
          notes: string | null
          paid_at: string | null
          status: Database["public"]["Enums"]["payout_status"]
          updated_at: string
          utr_reference: string | null
        }
        Insert: {
          commission_paise: number
          created_at?: string
          event_id: string
          gross_paise: number
          host_id: string
          id?: string
          net_paise: number
          notes?: string | null
          paid_at?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          updated_at?: string
          utr_reference?: string | null
        }
        Update: {
          commission_paise?: number
          created_at?: string
          event_id?: string
          gross_paise?: number
          host_id?: string
          id?: string
          net_paise?: number
          notes?: string | null
          paid_at?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          updated_at?: string
          utr_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payouts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: true
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          note: string | null
          profile_id: string
        }
        Insert: {
          created_at?: string
          note?: string | null
          profile_id: string
        }
        Update: {
          created_at?: string
          note?: string | null
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_admins_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          city: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          city?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          city?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_webhook_events: {
        Row: {
          error: string | null
          event_type: string | null
          id: string
          payload: Json
          processed_at: string | null
          provider: string
          provider_event_id: string
          received_at: string
        }
        Insert: {
          error?: string | null
          event_type?: string | null
          id?: string
          payload: Json
          processed_at?: string | null
          provider?: string
          provider_event_id: string
          received_at?: string
        }
        Update: {
          error?: string | null
          event_type?: string | null
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id?: string
          received_at?: string
        }
        Relationships: []
      }
      refunds: {
        Row: {
          amount_paise: number
          created_at: string
          id: string
          payment_id: string
          provider_refund_id: string | null
          reason: string | null
          status: Database["public"]["Enums"]["refund_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          id?: string
          payment_id: string
          provider_refund_id?: string | null
          reason?: string | null
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          id?: string
          payment_id?: string
          provider_refund_id?: string | null
          reason?: string | null
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_types: {
        Row: {
          created_at: string
          description: string | null
          event_id: string
          id: string
          max_per_order: number
          name: string
          price_paise: number
          quantity: number
          reserved_count: number
          sales_end: string | null
          sales_start: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          event_id: string
          id?: string
          max_per_order?: number
          name: string
          price_paise: number
          quantity: number
          reserved_count?: number
          sales_end?: string | null
          sales_start?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          event_id?: string
          id?: string
          max_per_order?: number
          name?: string
          price_paise?: number
          quantity?: number
          reserved_count?: number
          sales_end?: string | null
          sales_start?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_types_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          attendee_name: string | null
          booking_id: string
          checked_in_at: string | null
          checked_in_by: string | null
          checked_in_offline: boolean
          code: string
          created_at: string
          id: string
        }
        Insert: {
          attendee_name?: string | null
          booking_id: string
          checked_in_at?: string | null
          checked_in_by?: string | null
          checked_in_offline?: boolean
          code: string
          created_at?: string
          id?: string
        }
        Update: {
          attendee_name?: string | null
          booking_id?: string
          checked_in_at?: string | null
          checked_in_by?: string | null
          checked_in_offline?: boolean
          code?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      approve_booking: {
        Args: {
          p_booking_id: string
          p_commission_paise?: number
          p_convenience_fee_paise?: number
          p_hold_hours?: number
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      begin_paid_booking: {
        Args: {
          p_attendee_id: string
          p_attendee_name: string
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      book_cash_tickets: {
        Args: {
          p_attendee_id: string
          p_attendee_name: string
          p_attendee_note?: string
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      book_free_tickets: {
        Args: {
          p_attendee_id: string
          p_attendee_name: string
          p_attendee_note?: string
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_booking: {
        Args: { p_booking_id: string; p_reason?: string }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      check_in_next_ticket: {
        Args: {
          p_booking_id: string
          p_checked_in_by: string
          p_event_id: string
        }
        Returns: {
          attendee_name: string
          checked_in_at: string
          outcome: string
          reference: string
          tickets_in: number
          tickets_total: number
        }[]
      }
      check_in_ticket: {
        Args: { p_checked_in_by: string; p_code: string; p_event_id: string }
        Returns: {
          attendee_name: string
          checked_in_at: string
          outcome: string
          reference: string
          tickets_in: number
          tickets_total: number
        }[]
      }
      confirm_booking: {
        Args: { p_booking_id: string }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_event_with_ticket_type: {
        Args: {
          p_allows_cash: boolean
          p_city: string
          p_cover_image_url: string
          p_description: string
          p_ends_at: string
          p_has_waitlist?: boolean
          p_hide_venue_until_approved: boolean
          p_host_id: string
          p_price_paise: number
          p_quantity: number
          p_refund_cutoff_hours?: number
          p_requires_approval: boolean
          p_slug: string
          p_starts_at: string
          p_title: string
          p_venue_address: string
          p_venue_name: string
        }
        Returns: {
          allows_cash: boolean
          category: string | null
          city: string
          cover_image_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          has_waitlist: boolean
          hide_venue_until_approved: boolean
          host_id: string
          id: string
          published_at: string | null
          refund_cutoff_hours: number
          requires_approval: boolean
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at: string
          venue_address: string | null
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string | null
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_host_id: { Args: never; Returns: string }
      generate_booking_reference: { Args: never; Returns: string }
      is_platform_admin: { Args: never; Returns: boolean }
      join_waitlist: {
        Args: {
          p_attendee_id: string
          p_attendee_name: string
          p_payment_mode?: Database["public"]["Enums"]["payment_mode"]
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      owns_event: { Args: { p_event_id: string }; Returns: boolean }
      promote_from_waitlist: {
        Args: { p_hold_hours?: number; p_ticket_type_id: string }
        Returns: number
      }
      release_expired_holds: {
        Args: { p_ticket_type_id?: string }
        Returns: number
      }
      request_booking: {
        Args: {
          p_attendee_id: string
          p_attendee_name: string
          p_attendee_note?: string
          p_payment_mode?: Database["public"]["Enums"]["payment_mode"]
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reserve_tickets: {
        Args: {
          p_attendee_id: string
          p_attendee_note?: string
          p_commission_paise?: number
          p_convenience_fee_paise?: number
          p_hold_minutes?: number
          p_payment_mode?: Database["public"]["Enums"]["payment_mode"]
          p_quantity: number
          p_ticket_type_id: string
        }
        Returns: {
          approved_at: string | null
          attendee_id: string
          attendee_name: string | null
          attendee_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          commission_paise: number
          confirmed_at: string | null
          convenience_fee_paise: number
          created_at: string
          event_id: string
          hold_expires_at: string | null
          id: string
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["booking_status"]
          subtotal_paise: number
          ticket_type_id: string
          total_paise: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_event_with_ticket_type: {
        Args: {
          p_allows_cash: boolean
          p_city: string
          p_cover_image_url: string
          p_description: string
          p_ends_at: string
          p_event_id: string
          p_has_waitlist?: boolean
          p_hide_venue_until_approved: boolean
          p_price_paise: number
          p_quantity: number
          p_refund_cutoff_hours?: number
          p_requires_approval: boolean
          p_starts_at: string
          p_title: string
          p_venue_address: string
          p_venue_name: string
        }
        Returns: {
          allows_cash: boolean
          category: string | null
          city: string
          cover_image_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          has_waitlist: boolean
          hide_venue_until_approved: boolean
          host_id: string
          id: string
          published_at: string | null
          refund_cutoff_hours: number
          requires_approval: boolean
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at: string
          venue_address: string | null
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string | null
        }
        SetofOptions: {
          from: "*"
          to: "events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      waitlist_length: { Args: { p_ticket_type_id: string }; Returns: number }
      waitlist_position: { Args: { p_booking_id: string }; Returns: number }
    }
    Enums: {
      booking_status:
        | "pending_approval"
        | "waitlisted"
        | "awaiting_payment"
        | "confirmed"
        | "cancelled"
        | "expired"
        | "refunded"
      event_status: "draft" | "published" | "cancelled" | "completed"
      host_kyc_status: "pending" | "submitted" | "verified" | "rejected"
      payment_mode: "online" | "cash"
      payment_status:
        | "created"
        | "authorized"
        | "captured"
        | "failed"
        | "refunded"
      payout_status: "pending" | "paid" | "on_hold"
      refund_status: "pending" | "processed" | "failed"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      booking_status: [
        "pending_approval",
        "waitlisted",
        "awaiting_payment",
        "confirmed",
        "cancelled",
        "expired",
        "refunded",
      ],
      event_status: ["draft", "published", "cancelled", "completed"],
      host_kyc_status: ["pending", "submitted", "verified", "rejected"],
      payment_mode: ["online", "cash"],
      payment_status: [
        "created",
        "authorized",
        "captured",
        "failed",
        "refunded",
      ],
      payout_status: ["pending", "paid", "on_hold"],
      refund_status: ["pending", "processed", "failed"],
    },
  },
} as const

