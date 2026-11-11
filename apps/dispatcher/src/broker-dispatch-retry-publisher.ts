import {
  type ConfirmPublisher,
  DISPATCH_ATTEMPT_HEADER,
  DISPATCH_EXHAUSTED,
  FAILURE_KIND_HEADER,
  FAILURE_REASON_HEADER,
  type PublishProperties,
  type TopologyNames,
} from '@wdp/messaging';
import type { ConsumeMessage } from 'amqplib';
import { DispatchRetryPublisher } from './dispatch-retry-publisher.js';

/**
 * Republishes an event message unchanged: same body, same ids. Only the
 * headers are new. The retry queue is reached through the default exchange,
 * which routes by queue name.
 */
export class BrokerDispatchRetryPublisher extends DispatchRetryPublisher {
  constructor(
    private readonly publisher: ConfirmPublisher,
    private readonly names: TopologyNames,
    private readonly retryDelayMs: number,
  ) {
    super();
  }

  retry(message: ConsumeMessage, attempt: number): Promise<void> {
    return this.publisher.publish(
      '',
      this.names.dispatchRetryQueue(this.retryDelayMs),
      message.content,
      this.copyOf(message, { [DISPATCH_ATTEMPT_HEADER]: attempt }),
    );
  }

  deadLetter(message: ConsumeMessage, reason: string): Promise<void> {
    // The dead-letter exchange is a fanout: the routing key is ignored.
    return this.publisher.publish(
      this.names.deadLetterExchange,
      '',
      message.content,
      this.copyOf(message, {
        [FAILURE_KIND_HEADER]: DISPATCH_EXHAUSTED,
        [FAILURE_REASON_HEADER]: reason,
      }),
    );
  }

  private copyOf(
    message: ConsumeMessage,
    headers: Record<string, unknown>,
  ): PublishProperties {
    const { messageId, correlationId, type } = message.properties;
    return {
      // The relay always sets these. The id is how consumers recognise repeats.
      messageId: typeof messageId === 'string' ? messageId : '',
      correlationId:
        typeof correlationId === 'string' ? correlationId : undefined,
      type: typeof type === 'string' ? type : undefined,
      headers,
    };
  }
}
