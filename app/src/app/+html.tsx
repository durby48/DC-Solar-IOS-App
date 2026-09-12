import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * Web-only root HTML, rendered once in Node at static-export time (so no
 * browser APIs here). Everything is Expo Router's default except the colour:
 * the document itself is painted the app's charcoal page, so the instant
 * before the bundle runs — and Safari's overscroll bounce beyond the root
 * view — never flashes white behind the dark palette. `color-scheme: dark`
 * also makes native form controls and scrollbars draw dark on the web.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#1E1C1A" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: 'html,body{background:#1E1C1A}' }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
