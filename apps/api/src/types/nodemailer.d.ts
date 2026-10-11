declare module 'nodemailer' {
  interface TransportOptions {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  }
  interface MailOptions {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    text: string;
    html: string;
  }
  interface SentMessageInfo {
    messageId: string;
  }
  interface Transporter {
    sendMail(opts: MailOptions): Promise<SentMessageInfo>;
  }
  function createTransport(opts: TransportOptions): Transporter;
  export default { createTransport };
}
