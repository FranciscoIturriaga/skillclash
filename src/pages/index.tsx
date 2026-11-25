/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * That makes it cheap to serve and safe for logged-out / crawler traffic.
 *
 * Need live data or auth here? Move this file to src/pages/(app)/index.tsx
 * and it becomes a dynamic page. Conversely, any page you want to keep static
 * (marketing, docs, legal) belongs at this top level.
 *
 * Top-level pages are also prerendered to static HTML at build
 * (prerender.ts, via vite.config.ts) so crawlers read real content.
 * Keep them renderable without a browser: no window/document during render,
 * prose in HTML text, reveal animations in CSS keyframes rather than JS-driven
 * initial states. `<Seo>` comes first and reads src/seo.ts.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div
        data-testid="static-landing"
        className="bg-arena flex min-h-screen flex-col justify-between px-6 py-8 sm:px-10"
      >
        <p className="font-display text-xl font-extrabold uppercase italic tracking-wide">
          Skill<span className="text-primary">Clash</span>
        </p>
        <main className="mx-auto w-full max-w-3xl py-16">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.25em] text-primary">3 rounds · 20 seconds · the crowd decides</p>
          <h1 className="font-display text-6xl font-extrabold uppercase italic leading-[0.88] text-foreground sm:text-8xl">
            Film it.
            <br />
            Clash it.
            <br />
            <span className="text-primary">Win the crowd.</span>
          </h1>
          <p className="mt-6 max-w-md text-lg text-muted-foreground">
            Challenge anyone to a video skill battle. You both film an attempt each round, the videos drop at the
            same time, and everyone else votes on who did it better.
          </p>
          <Link
            to="/home"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-base font-bold uppercase tracking-wide text-primary-foreground transition-opacity hover:opacity-90"
          >
            Enter the arena
          </Link>
        </main>
        <ol className="mx-auto grid w-full max-w-3xl gap-4 text-sm sm:grid-cols-3">
          <li className="rounded-xl border border-border bg-card/70 p-4">
            <span className="font-display text-2xl font-extrabold text-side-a">01</span>
            <p className="mt-1 text-muted-foreground">Challenge a player by username and name the first skill.</p>
          </li>
          <li className="rounded-xl border border-border bg-card/70 p-4">
            <span className="font-display text-2xl font-extrabold text-side-b">02</span>
            <p className="mt-1 text-muted-foreground">Both film within the window. Videos stay hidden until it closes.</p>
          </li>
          <li className="rounded-xl border border-border bg-card/70 p-4">
            <span className="font-display text-2xl font-extrabold text-primary">03</span>
            <p className="mt-1 text-muted-foreground">The crowd votes. Win rounds, earn points, build your record.</p>
          </li>
        </ol>
      </div>
    </>
  )
}
