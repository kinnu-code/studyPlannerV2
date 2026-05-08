'use strict';
/* global Vue, StudyApp, StudyStorage */

async function bootstrap() {
  try {
    const res = await fetch('data/settings.json');
    if (res.ok) StudyStorage.setDefaults(await res.json());
  } catch (_) {}
  Vue.createApp(StudyApp).mount('#app');
}
bootstrap();
