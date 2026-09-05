import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import type { Content, Part } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import { ArrowUp, Mic, Paperclip, Square } from 'lucide-react';

const apiKey = import.meta.env.VITE_GOOGLE_API_KEY || import.meta.env.VITE_GEMINI_API_KEY;
const modelId = import.meta.env.VITE_GOOGLE_MODEL_ID || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey });

async function generateContent(contents: Content[]): Promise<string> {
  if (!apiKey) {
    throw new Error('Falta la API key. Configura VITE_GEMINI_API_KEY o GOOGLE_API_KEY y reinicia o vuelve a desplegar.');
  }

  const response = await ai.models.generateContent({
    model: modelId,
    contents,
  });
  return response.text || '';
}

type ChatSession = {
  id: string;
  title: string;
  conversation: Content[];
};

function textOnlyConversation(conversation: Content[]): Content[] {
  return conversation.map((content) => ({
    role: content.role,
    parts: (content.parts || []).filter((part) => part.text).map((part) => ({ text: part.text })),
  }));
}

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [answer, setAnswer] = useState('');
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [conversation, setConversation] = useState<Content[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const [chatHistory, setChatHistory] = useState<ChatSession[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('agente-chat-history') || '[]') as ChatSession[];
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    localStorage.setItem('agente-chat-history', JSON.stringify(chatHistory));
  }, [chatHistory]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((!prompt.trim() && !documentFile) || loading) return;

    setLoading(true);
    setError('');
    setAnswer('');

    try {
      const question = prompt.trim() || (documentFile?.type.startsWith('audio/')
        ? 'Transcribe este audio y resume sus puntos principales.'
        : 'Resume este documento y destaca sus puntos principales.');
      setSubmittedPrompt(question);
      setPrompt('');
      let currentParts: Part[] = [{ text: question }];

      if (documentFile) {
        if (documentFile.size > 20 * 1024 * 1024) {
          throw new Error('El documento supera el límite de 20 MB.');
        }

        if (documentFile.type === 'text/plain' || documentFile.name.match(/\.(md|csv|json)$/i)) {
          currentParts = [{ text: `${question}\n\nDocumento: ${await documentFile.text()}` }];
        } else {
          const documentData = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('No se pudo leer el documento.'));
            reader.readAsDataURL(documentFile);
          });
          currentParts.push({ inlineData: { mimeType: documentFile.type || 'application/pdf', data: documentData } });
        }
      }

      const currentContent: Content = { role: 'user', parts: currentParts };
      const nextConversation = [...conversation, currentContent];
      const responseText = await generateContent(nextConversation) || 'Gemini no devolvió texto.';
      setAnswer(responseText);
      setConversation([...nextConversation, { role: 'model', parts: [{ text: responseText }] }]);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : '';
      setError(
        message.includes('supera el límite')
          ? message
          : message.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') || message.includes('invalid authentication credentials')
          ? 'La credencial configurada es un token OAuth. Usa una API key de Google AI Studio en VITE_GEMINI_API_KEY o GOOGLE_API_KEY y vuelve a desplegar.'
          : message.includes('API_KEY_INVALID') || message.includes('API key not valid')
          ? 'La API key de Gemini no es válida. Copia la clave de Google AI Studio en VITE_GEMINI_API_KEY dentro de .env y reinicia o vuelve a desplegar.'
          : `No se pudo conectar con Gemini. ${message || 'Revisa la API key y vuelve a intentarlo.'}`,
      );
    } finally {
      setLoading(false);
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function toggleRecording() {
    if (recording && recorderRef.current) {
      recorderRef.current.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Tu navegador no permite grabar audio desde esta página.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const audioBlob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setRecording(false);
        void transcribeAudio(audioBlob);
      };
      recorder.start();
      setRecording(true);
      setError('');
    } catch {
      setError('No se pudo acceder al micrófono. Revisa los permisos del navegador.');
    }
  }

  async function transcribeAudio(audioBlob: Blob) {
    setTranscribing(true);
    setError('');
    setDocumentFile(null);
    setPrompt('Transcribiendo audio...');

    try {
      const audioData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('No se pudo leer la grabación.'));
        reader.readAsDataURL(audioBlob);
      });
      const responseText = await generateContent([{
        role: 'user',
        parts: [
          { text: 'Transcribe este audio exactamente en español. Devuelve solo la transcripción, sin explicación adicional.' },
          { inlineData: { mimeType: audioBlob.type || 'audio/webm', data: audioData } },
        ],
      }]);
      setPrompt(responseText);
    } catch {
      setPrompt('');
      setError('No se pudo transcribir el audio. Inténtalo de nuevo.');
    } finally {
      setTranscribing(false);
    }
  }

  function startNewChat() {
    if (submittedPrompt && conversation.length > 0) {
      setChatHistory((history) => [
        { id: sessionId, title: submittedPrompt, conversation: textOnlyConversation(conversation) },
        ...history.filter((chat) => chat.id !== sessionId),
      ].slice(0, 8));
    }
    setSessionId(crypto.randomUUID());
    setPrompt('');
    setDocumentFile(null);
    setAnswer('');
    setSubmittedPrompt('');
    setConversation([]);
    setError('');
  }

  function openChat(chat: ChatSession) {
    const firstUserMessage = chat.conversation.find((content) => content.role === 'user')?.parts?.find((part) => part.text)?.text || chat.title;
    const lastAssistantMessage = [...chat.conversation].reverse().find((content) => content.role === 'model')?.parts?.find((part) => part.text)?.text || '';
    setSessionId(chat.id);
    setConversation(chat.conversation);
    setSubmittedPrompt(firstUserMessage);
    setAnswer(lastAssistantMessage);
    setPrompt('');
    setDocumentFile(null);
    setError('');
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark">A</div><strong>Agente</strong></div>
        <button className="new-chat" type="button" onClick={startNewChat}>+ <span>Nueva conversación</span></button>
        <p className="sidebar-label">Conversaciones</p>
        <button className="history-item active" type="button">⌁ <span>Conversación actual</span></button>
        {chatHistory.length > 0 && <p className="sidebar-label previous-label">Anteriores</p>}
        <div className="history-list">
          {chatHistory.map((chat) => (
            <button className="history-item previous" key={chat.id} title={chat.title} onClick={() => openChat(chat)} type="button">
              <span>⌁</span>
              <span>{chat.title}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom"><span className="status"><span /> Gemini conectado</span><small>Tu espacio privado</small></div>
      </aside>
      <section className="workspace">
        <header className="chat-header"><div><p className="eyebrow">Asistente virtual</p><h1>Agente</h1></div><button className="mobile-new" type="button" onClick={startNewChat}>+</button></header>
        <div className="chat-area">
          {!answer && !submittedPrompt ? <div className="welcome"><div className="welcome-icon">✦</div><h2>¿Qué necesitas resolver hoy?</h2><p>Pregunta, crea ideas, aprende algo nuevo o comparte un archivo.</p></div> : <div className="messages">
            <div className="user-message"><span className="avatar user-avatar">Tú</span><p>{submittedPrompt}</p></div>
            {loading ? <div className="assistant-message"><span className="avatar assistant-avatar">A</span><p className="typing">Analizando<span>...</span></p></div> : answer && <div className="assistant-message"><span className="avatar assistant-avatar">A</span><div className="answer-content"><ReactMarkdown>{answer}</ReactMarkdown></div></div>}
          </div>}
        </div>
        <form onSubmit={handleSubmit}>
          {documentFile && <div className="file-chip"><Paperclip size={14} /> <span>{documentFile.name}</span></div>}
          <div className="question-row">
            <label className="attach-button" title="Adjuntar archivo" aria-label="Adjuntar archivo">
              <Paperclip size={18} aria-hidden="true" />
              <input
                type="file"
                accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/csv,application/json"
                onChange={(event) => setDocumentFile(event.target.files?.[0] || null)}
                disabled={loading || transcribing}
              />
            </label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="¿Qué quieres saber hoy?"
              rows={3}
              disabled={loading || transcribing}
              onKeyDown={handlePromptKeyDown}
            />
            <button className="send-button" type="submit" disabled={loading || transcribing || (!prompt.trim() && !documentFile)} aria-label="Enviar mensaje">
              {loading ? <span>...</span> : <ArrowUp size={18} aria-hidden="true" />}
            </button>
            <button className={`audio-button ${recording ? 'recording' : ''}`} type="button" onClick={() => void toggleRecording()} disabled={loading || transcribing} title={recording ? 'Detener grabación' : transcribing ? 'Transcribiendo audio' : 'Grabar audio'} aria-label={recording ? 'Detener grabación' : 'Grabar audio'}>
              {recording ? <Square size={16} aria-hidden="true" /> : transcribing ? <span>...</span> : <Mic size={18} aria-hidden="true" />}
            </button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="composer-hint">Puedes adjuntar documentos o audios. Agente puede cometer errores.</p>
      </section>
    </main>
  );
}
