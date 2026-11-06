import { useEffect, useMemo } from 'react'
import type {
  AnnotationMessage,
  AnnotationsMessage,
  ClientMessage,
} from '../../shared/protocol.ts'
import { AnnotationStore } from './annotationStore.ts'

/** The room's marks on its shares (J2, e7-t04), for as long as the room page is up */
export function useAnnotationStore(
  send: (message: ClientMessage) => void,
  onAnnotation: (listener: (message: AnnotationMessage | AnnotationsMessage) => void) => () => void,
  isOpen: () => boolean,
): AnnotationStore {
  const store = useMemo(() => new AnnotationStore({ send, isOpen }), [send, isOpen])
  useEffect(() => onAnnotation((message) => store.receive(message)), [onAnnotation, store])
  return store
}
