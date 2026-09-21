import { afterNextRender, ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { OcrSessionService } from './ocr/ocr-session.service';
import { OcrSettingsComponent } from './ocr/ocr-settings.component';
import { PpssppRuntime } from './ppsspp-runtime';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [OcrSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly runtime = inject(PpssppRuntime);
  readonly ocr = inject(OcrSessionService);

  constructor() {
    afterNextRender(() => {
      void this.runtime
        .bootstrap()
        .then(() => {
          const host = document.getElementById('ocrOverlay');
          if (host) return this.ocr.attach(host);
          return undefined;
        })
        .catch((error: unknown) => console.error(error));
    });
  }
}
