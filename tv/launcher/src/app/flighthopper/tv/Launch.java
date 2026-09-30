package app.flighthopper.tv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/**
 * The FlightHopper tile: starts (or resumes) the FlightHopper app streamed from omarchy, through Moonlight's shortcut
 * entry (the same one its home-screen channel uses), and gets out of the way. Moonlight is the patched build in
 * tv/moonlight, whose remote OK is Enter and Back is Escape on the stream.
 */
public class Launch extends Activity {
    static final String HOST = "omarchy"; // the Sunshine host's name as Moonlight paired it
    static final String APP = "FlightHopper"; // the app in Sunshine's apps.json

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent i = new Intent().setClassName("com.limelight", "com.limelight.ShortcutTrampoline")
                .putExtra("Name", HOST).putExtra("AppName", APP).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "FlightHopper needs Moonlight (tv/moonlight in the FlightHopper repo)", Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
