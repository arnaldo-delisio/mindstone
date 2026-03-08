import { supabase } from '../services/supabase.js';
import { logger } from './logger.js';

export interface AnalyticsEvent {
  operation_type: 'extraction' | 'tagging' | 'summarization' | 'embeddings' | 'moc_generation' | 'moc_check' | 'api_request' | 'upload';
  status: 'success' | 'failed' | 'timeout';
  duration_ms: number;

  // Cost tracking
  model_used?: string;
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: number;
  free_tier_used?: boolean;

  // Error tracking
  error_type?: string;
  error_message?: string;
  retry_count?: number;

  // Content metadata
  file_id?: string;
  source_url?: string;
  content_type?: 'youtube' | 'article' | 'pdf' | 'epub' | 'docx' | 'learning' | 'github' | 'repository';
  content_size_bytes?: number;
  content_length_tokens?: number;

  // Performance details
  queue_wait_ms?: number;
  api_latency_ms?: number;
  db_latency_ms?: number;

  // Request context
  request_source?: 'mcp' | 'pwa' | 'queue' | 'api';
  request_path?: string;
  request_method?: string;

  // Results
  tags_generated?: number;
  summary_length_tokens?: number;
  moc_updated?: boolean;
  chunks_created?: number;
}

/**
 * Track analytics event to Supabase analytics table
 * Non-blocking - logs errors but doesn't throw
 */
export async function trackAnalytics(event: AnalyticsEvent): Promise<void> {
  try {
    const { error } = await supabase.from('analytics').insert({
      ...event,
      timestamp: new Date().toISOString()
    });

    if (error) {
      logger.error({ error, event }, 'Failed to track analytics');
    }
  } catch (error) {
    // Non-blocking - don't throw errors from analytics tracking
    logger.error({ error, event }, 'Analytics tracking error');
  }
}
