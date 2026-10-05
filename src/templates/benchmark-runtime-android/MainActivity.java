package io.sandcastle.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    TextView label = new TextView(this);
    label.setText("Candidate ready");
    label.setTextSize(28);
    label.setPadding(32, 64, 32, 32);
    setContentView(label);
  }
}
