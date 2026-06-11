import { createRouter, createWebHashHistory } from 'vue-router';
import ChatPage from '../pages/ChatPage.vue';
import ConfigPage from '../pages/ConfigPage.vue';
import SessionsPage from '../pages/SessionsPage.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'chat', component: ChatPage },
    { path: '/config', name: 'config', component: ConfigPage },
    { path: '/sessions', name: 'sessions', component: SessionsPage },
  ],
});

export default router;
