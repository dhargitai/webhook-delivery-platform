import {
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
  connect,
} from 'amqplib';

/**
 * One broker connection. An unhandled `error` event would crash the process
 * (or, for a channel error, silently kill just that channel), so the caller
 * must say what happens to errors up front.
 */
export class BrokerConnection {
  private closed = false;

  private constructor(
    private readonly model: ChannelModel,
    private readonly onError: (error: Error) => void,
  ) {
    // amqplib emits `close` however the connection ends: closed by us, by
    // the broker, or dropped with the network.
    model.on('close', () => {
      this.closed = true;
    });
  }

  static async connect(
    url: string,
    onError: (error: Error) => void,
  ): Promise<BrokerConnection> {
    const model = await connect(url);
    model.on('error', onError);
    return new BrokerConnection(model, onError);
  }

  async createChannel(): Promise<Channel> {
    const channel = await this.model.createChannel();
    channel.on('error', this.onError);
    return channel;
  }

  async createConfirmChannel(): Promise<ConfirmChannel> {
    const channel = await this.model.createConfirmChannel();
    channel.on('error', this.onError);
    return channel;
  }

  async close(): Promise<void> {
    // amqplib refuses to close a connection that is already closed, and one
    // that dropped has nothing left to release.
    if (this.closed) return;
    await this.model.close();
  }
}
