import { createApp } from 'vue';
import UplApp from './UplApp.vue';
import { installAuthFetch } from '../authFetch';
import '../styles.css';

installAuthFetch();

createApp(UplApp).mount('#upl');
