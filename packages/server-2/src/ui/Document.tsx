import type { PropsWithChildren } from 'hono/jsx';
import styles from './styles.css';
import { SCRIPT } from './script';

type DocumentProps = PropsWithChildren<{ title: string; withScript?: boolean; bodyClass?: string }>;

export function Document({ title, withScript, bodyClass, children }: DocumentProps) {
  return (
    <html lang='en'>
      <head>
        <meta charset='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <meta name='robots' content='noindex' />
        <title>{title}</title>
        <link rel='preconnect' href='https://fonts.googleapis.com' />
        <link
          rel='stylesheet'
          href='https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Fira+Sans:wght@400;500;600&display=swap'
        />
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body class={bodyClass}>
        {children}
        {withScript ? <script dangerouslySetInnerHTML={{ __html: SCRIPT }} /> : null}
      </body>
    </html>
  );
}
