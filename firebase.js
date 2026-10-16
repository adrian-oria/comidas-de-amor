// Inicialización compartida por la app y la migración
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

const app = initializeApp({
  apiKey: 'AIzaSyD-ru4qnpigSEBgJXCkuSA0RFIig5cG4vM',
  authDomain: 'comidas-amor.firebaseapp.com',
  databaseURL: 'https://comidas-amor-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'comidas-amor',
  storageBucket: 'comidas-amor.firebasestorage.app',
  messagingSenderId: '638263876216',
  appId: '1:638263876216:web:4493d7a254cb690e8dab8d'
});

export const auth = getAuth(app);
auth.languageCode = 'es'; // emails de verificación y recuperación en español
export const db = getDatabase(app);