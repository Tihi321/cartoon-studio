import type { ImageContext, ImageProvider } from './provider'

/**
 * The Nano Banana (Gemini API image) provider. A stub until CTS-11 writes it: the name is in `IMAGE_PROVIDERS`, so `pick('gemini', ctx)` resolves, and
 * `generate` refuses with a clear error before anything leaves the machine. CTS-11 replaces this body (behind `charge`, key in the keyring, USD cap $0
 * until the user agrees to spend).
 */
export function geminiProvider(_ctx: ImageContext): ImageProvider {
  return {
    id: 'gemini',
    async generate() {
      throw new Error('the gemini image provider (Nano Banana) is not implemented until CTS-11; nothing was sent and nothing was spent')
    }
  }
}
