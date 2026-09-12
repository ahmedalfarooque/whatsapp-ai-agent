import { Routes, Route } from 'react-router-dom';
import { SiteHeader } from './components/layout/SiteHeader';
import { SiteFooter } from './components/layout/SiteFooter';
import { Home } from './pages/Home';
import { Services } from './pages/Services';
import { ServiceDetail } from './pages/ServiceDetail';
import { Products } from './pages/Products';
import { ProductCategoryPage } from './pages/ProductCategory';
import { ProductDetail } from './pages/ProductDetail';
import { Offers } from './pages/Offers';
import { Gallery } from './pages/Gallery';
import { Social } from './pages/Social';
import { Contact } from './pages/Contact';
import { NotFound } from './pages/NotFound';

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/services" element={<Services />} />
          <Route path="/services/:slug" element={<ServiceDetail />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:category" element={<ProductCategoryPage />} />
          <Route path="/products/:category/:slug" element={<ProductDetail />} />
          <Route path="/offers" element={<Offers />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/social" element={<Social />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <SiteFooter />
    </div>
  );
}
