import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-orange-500 mb-4">404</h1>
        <p className="text-xl text-gray-400 mb-8">Pagina nu a fost gasita</p>
        <Link
          href="/"
          className="px-6 py-3 bg-orange-500 rounded-lg hover:bg-orange-600 transition-colors"
        >
          Inapoi la Source
        </Link>
      </div>
    </div>
  );
}
