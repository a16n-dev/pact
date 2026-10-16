import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import './hazel.css';

// Extend the default theme with a "For LLMs" link injected above each doc.
export default {
  ...DefaultTheme,
  Layout,
};
