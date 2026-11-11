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
  private constructor(
    private readonly model: ChannelModel,
    private readonly onError: (error: Error) => void,
  ) {}

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
    await this.model.close();
  }
}
