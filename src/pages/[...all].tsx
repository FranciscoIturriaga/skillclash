import { Link } from 'react-router-dom'
import { APP_NAME } from '../constants'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center text-center px-4">
      <title>{`Not found · ${APP_NAME}`}</title>
      <meta name="robots" content="noindex" />
      <h1 className="font-display mb-2 text-7xl font-extrabold italic text-primary">404</h1>
      <p className="mb-6 text-muted-foreground">Out of bounds. That page doesn't exist.</p>
      <Link
        to="/home"
        className="rounded-xl bg-primary px-5 py-2.5 text-sm font-bold uppercase text-primary-foreground hover:opacity-90 transition-opacity"
      >
        Back to the arena
      </Link>
    </div>
  )
}
