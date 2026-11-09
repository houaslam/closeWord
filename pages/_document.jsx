import Document, { Html, Head, Main, NextScript } from "next/document";
export default class GameDocument extends Document {
  static async getInitialProps(ctx) {
    const props = await Document.getInitialProps(ctx);
    return { ...props, nonce: ctx.req?.headers["x-nonce"] };
  }
  render() {
    return (
      <Html lang="en" className="dark">
        <Head nonce={this.props.nonce}>
          <link rel="icon" href="/favicon.svg" />
          <meta name="theme-color" content="#191919" />
        </Head>
        <body>
          <Main />
          <NextScript nonce={this.props.nonce} />
        </body>
      </Html>
    );
  }
}
