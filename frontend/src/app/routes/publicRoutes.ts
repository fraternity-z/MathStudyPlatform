import { lazy } from 'react';
import type { RouteConfig } from './index';

// 公共页面懒加载
const WelcomePage = lazy(() => import('@/pages/common/WelcomePage').then(m => ({ default: m.WelcomePage })));
const PersonalHomePage = lazy(() => import('@/pages/common/PersonalHomePage').then(m => ({ default: m.PersonalHomePage })));
const ProfilePage = lazy(() => import('@/pages/common/ProfilePage').then(m => ({ default: m.ProfilePage })));
const PrivacyPolicyPage = lazy(() => import('@/pages/common/PrivacyPolicyPage').then(m => ({ default: m.PrivacyPolicyPage })));
const TermsOfServicePage = lazy(() => import('@/pages/common/TermsOfServicePage').then(m => ({ default: m.TermsOfServicePage })));
const GuidePage = lazy(() => import('@/pages/common/GuidePage').then(m => ({ default: m.GuidePage })));
const FAQPage = lazy(() => import('@/pages/common/FAQPage').then(m => ({ default: m.FAQPage })));
const AboutPage = lazy(() => import('@/pages/common/AboutPage').then(m => ({ default: m.AboutPage })));
const ContactPage = lazy(() => import('@/pages/common/ContactPage').then(m => ({ default: m.ContactPage })));
/**
 * 公共页面路由 - 首页和个人资料仍要求登录
 */
export const publicRoutes: RouteConfig[] = [
  { path: '/welcome', component: WelcomePage, protected: false },
  { path: '/home', component: PersonalHomePage, protected: true },
  { path: '/privacy-policy', component: PrivacyPolicyPage, protected: false },
  { path: '/terms-of-service', component: TermsOfServicePage, protected: false },
  { path: '/guide', component: GuidePage, protected: false },
  { path: '/faq', component: FAQPage, protected: false },
  { path: '/about', component: AboutPage, protected: false },
  { path: '/contact', component: ContactPage, protected: false },
  { path: '/profile', component: ProfilePage, protected: true },
];
